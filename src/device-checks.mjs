import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sign } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { loadApplicationConfig } from './app-config.mjs';
import { runApplication, assertPortFree } from './app-runtime.mjs';
import { waitForApplication } from './app-readiness.mjs';
import { deviceControlRequest } from './device-transport.mjs';
import { deviceTlsOptions } from './device-identity.mjs';
import { challengeBytes } from './device-auth.mjs';
import { request, stream } from './app-protocol-checks.mjs';
import { privateDirectory, createPrivate, replacePrivate } from './device-store.mjs';
import { VERSION } from './version.mjs';

export async function checkDeviceClient({ clientFile, out }, { signals = process, onEvent = () => {}, runtimeOptions = {},
  evidence = 'application-device-B-ECS-A', timeoutMs = 20000 } = {}) {
  if (!clientFile || !out) throw new Error('check-device requires explicit --client-config and --out');
  const config = await loadApplicationConfig(clientFile, 'client');
  if (config.transport !== 'app-device' || config.mode !== 'mock') throw new Error('check-device requires an independent approved v2 MOCK profile; never tests real HAI');
  const destination = path.resolve(out);
  await privateDirectory(path.dirname(destination), { create: true });
  const report = { transport: 'app-device', mock: true, hai: 'not_called', version: VERSION, platform: process.platform,
    node: process.versions.node, evidence, session_time_basis: 'authenticated_server_http_date', status: 'fail', checks: [],
    not_checked: ['A_revocation', 'A_server_certificate_renewal', 'session_expiry', 'SSH_link_recovery', 'VPN_sleep_resume', 'real_HAI', 'real_AI_tool_session', 'Windows_ACL', 'long_term_stability'] };
  // Claim before networking, including concurrent invocations. Failure leaves a safe partial report.
  await createPrivate(destination, JSON.stringify(report, null, 2) + '\n');
  const owned = new EventEmitter(), abort = new AbortController();
  let service, runtime, ended = false, code, failure, interrupted = false, ready;
  const listening = new Promise(resolve => { ready = resolve; });
  const stop = () => { interrupted = true; abort.abort(); owned.emit('SIGTERM'); };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  const run = async (name, action) => {
    try { if (abort.signal.aborted || ended) throw new Error('Checks interrupted'); await action(); report.checks.push({ check: name, status: 'pass' }); }
    catch (error) {
      const result = { check: name, status: 'fail' };
      if (error.code === 'DEVICE_CHECK_MODELS_STATUS') {
        result.http_status = error.httpStatus; result.reason = error.reason;
      }
      report.checks.push(result); throw new Error('Device acceptance check failed');
    }
  };
  const headers = { authorization: 'Bearer ' + config.token };
  const get = (route = '/openai/v1/models', options = {}) => request(service.origin, route, { headers, ...options });
  const models = async () => {
    const response = await get();
    if (response.status !== 200) {
      let code; try { code = JSON.parse(response.body).error?.code; } catch {}
      const reason = ['application_authentication_unavailable', 'application_client_unauthorized', 'application_tls_transport_failed', 'bridge_unauthorized'].includes(code)
        ? code : 'mock_models_http_error';
      throw Object.assign(new Error('Mock model list unavailable'), { code: 'DEVICE_CHECK_MODELS_STATUS', httpStatus: response.status, reason });
    }
    const body = JSON.parse(response.body); assert.equal(body.mock, true); assert.equal(body.data[0].id, 'relay-ok');
    for (const key of ['requests', 'activeStreams', 'completedStreams', 'cancelledStreams']) assert.ok(Number.isSafeInteger(body.stats[key]) && body.stats[key] >= 0);
    return body.stats;
  };
  const noUpstream = async action => { const before = await models(); await action(); const after = await models(); assert.equal(after.requests, before.requests + 1); };
  try {
    runtime = runApplication(config, { ...runtimeOptions, signals: owned, onEvent, onListening(value) { service = value; ready(); } })
      .then(value => { code = value; ended = true; }, error => { failure = error; ended = true; abort.abort(); });
    await Promise.race([listening, runtime]);
    if (!service || interrupted || ended) throw new Error('Device check startup unavailable');
    await waitForApplication(config, { signal: abort.signal, shouldStop: () => ended, timeoutMs });
    await run('server-tls-device-session-and-mock-identity', async () => { assert.equal((await models()).activeStreams, 0); });
    await run('missing-and-wrong-local-token', () => noUpstream(async () => {
      for (const value of [{}, { authorization: 'Bearer wrong' }]) assert.equal((await get('/openai/v1/models', { headers: value })).status, 401);
    }));
    const origin = 'https://127.0.0.1:' + config.tunnelPort, trust = config.pair.trust;
    await run('wrong-server-pin-and-name', () => noUpstream(async () => {
      for (const invalid of [{ ...trust, server_spki_pin: '0'.repeat(64) }, { ...trust, server_name: 'wrong.invalid' }])
        await assert.rejects(async () => request(origin, '/healthz', { headers: {}, security: deviceTlsOptions(invalid) }));
    }));
    await run('missing-network-session-and-local-token-not-network-credential', () => noUpstream(async () => {
      for (const value of [{}, headers]) assert.equal((await request(origin, '/openai/v1/models', { headers: value, security: deviceTlsOptions(trust) })).status, 401);
    }));
    await run('unknown-device-and-one-time-challenge', () => noUpstream(async () => {
      await assert.rejects(deviceControlRequest(trust, config.tunnelPort, '/bridge/v2/challenge', { instance_id: trust.instance_id, device_id: '0'.repeat(64) }));
      const device = config.pair.identity;
      const challenge = await deviceControlRequest(trust, config.tunnelPort, '/bridge/v2/challenge', { instance_id: trust.instance_id, device_id: device.device_id });
      const signed = { instance_id: trust.instance_id, device_id: device.device_id, challenge_id: challenge.challenge_id,
        signature: sign(null, challengeBytes(challenge), device.key).toString('base64url') };
      await deviceControlRequest(trust, config.tunnelPort, '/bridge/v2/session', signed);
      await assert.rejects(deviceControlRequest(trust, config.tunnelPort, '/bridge/v2/session', signed));
    }));
    await run('control-plane-not-exposed-to-agent-and-route-limits', () => noUpstream(async () => {
      assert.equal((await get('/bridge/v2/challenge', { method: 'POST', body: '{}' })).status, 404);
      assert.equal((await get('/not-allowed')).status, 404);
      assert.equal((await get('/openai/v1/models', { method: 'POST', body: '{}' })).status, 405);
    }));
    await run('json-unicode', async () => { const reply = await get('/openai/v1/responses?case=json', { method: 'POST', body: '{}' }); assert.equal(reply.status, 200); assert.match(reply.body, /中文/); });
    await run('unicode-sse-incremental', async () => {
      const s = stream(service.origin, 'stream', { headers }); const result = await s.done;
      assert.equal(result.complete, true); assert.match(result.received, /中文/); assert.match(result.received, /response.completed/); assert.ok(result.lastAt > result.firstAt);
    });
    await run('four-concurrent-sse', async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => stream(service.origin, 'stream', { headers }).done));
      assert.ok(results.every(value => value.complete && value.received.includes('response.completed')));
    });
    await run('cancel-cleans-up-upstream', async () => {
      const before = await models(), s = stream(service.origin, 'cancel', { headers });
      try { await s.started; } finally { s.cancel(); }
      for (let i = 0; i < 40; i++) { const current = await models(); if (current.activeStreams === 0 && current.cancelledStreams > before.cancelledStreams) return; await pause(100); }
      throw new Error('Cancellation not observed');
    });
    for (const status of [429, 503]) await run('status-' + status + '-no-replay', async () => {
      const before = await models(), reply = await get('/openai/v1/responses?case=' + status, { method: 'POST', body: '{}' }), after = await models();
      assert.equal(reply.status, status); assert.equal(reply.headers['retry-after'], '7'); assert.equal(after.requests, before.requests + 2);
    });
    await run('final-health', async () => { assert.equal((await models()).activeStreams, 0); });
    report.status = 'pass';
  } catch { if (!report.checks.some(item => item.status === 'fail')) report.checks.push({ check: 'startup-and-approval', status: 'fail' }); }
  finally {
    abort.abort(); owned.emit('SIGTERM'); await runtime;
    if (failure || code !== 0) report.status = 'fail';
    for (const [check, port] of [['owned-http-port-released', config.localPort], ['owned-tls-tunnel-port-released', config.tunnelPort]]) {
      if (!service) { report.checks.push({ check, status: 'not-run' }); continue; }
      try { await assertPortFree(port); report.checks.push({ check, status: 'pass' }); }
      catch { report.checks.push({ check, status: 'fail' }); report.status = 'fail'; }
    }
    if (interrupted) report.status = 'interrupted';
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
    await replacePrivate(destination, JSON.stringify(report, null, 2) + '\n');
  }
  return { report, destination };
}
