import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { loadClientConfig, validatePort } from './config.mjs';
import { MOCK_RELAY_TOKEN } from './relay-config.mjs';
import { runTunnel } from './tunnel.mjs';
import { diagnoseOffline } from './preflight.mjs';
import { versionInfo } from './version.mjs';

class CheckFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const ensure = (condition, reason) => { if (!condition) throw new CheckFailure(reason); };
const reasonOf = error => error instanceof CheckFailure ? error.reason : 'check_error';
const IDS = ['mock_config', 'free_port', 'mock_ready', 'unicode_sse', 'inner_recovery',
  'new_request', 'final_quiet', 'stop_owned_ssh', 'port_released'];

export function validateLifecycleConfig(config, interruptSsh = false) {
  ensure(config.token === MOCK_RELAY_TOKEN && config.model === 'relay-ok' && !config.localOnly
    && config.target === 'hai-bridge-mac' && config.sshConfigFile
    && config.remoteHost === '127.0.0.1' && config.remotePort === 18080, 'mock_relay_config_required');
  validatePort(config.localPort, 'local_port');
  ensure(!interruptSsh || (config.reconnect && config.maxRetries >= 1 && config.maxRetries <= 5), 'bounded_reconnect_required');
}

export async function requireFreePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new CheckFailure('local_port_unavailable')));
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

function jsonRequest(origin, route, { signal, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '', ended = false;
    const finish = (error, value) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const req = http.request(origin + route, { headers: { Authorization: 'Bearer ' + MOCK_RELAY_TOKEN }, agent: false }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 65536) abort(); else body += chunk; });
      res.on('error', () => finish(new CheckFailure('http_unavailable')));
      res.on('end', () => {
        try { ensure(res.statusCode === 200, 'http_status'); finish(null, JSON.parse(body)); }
        catch (error) { finish(error instanceof CheckFailure ? error : new CheckFailure('invalid_mock_json')); }
      });
    });
    const abort = () => req.destroy(new Error('local_check_abort'));
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', () => finish(new CheckFailure(signal?.aborted ? 'cancelled' : 'http_unavailable')));
    if (signal?.aborted) abort(); else req.end();
  });
}

function observeStream(origin, scenario, { signal, timeoutMs }) {
  let resolveFirst, resolveDone, ended = false, timer, pending = '', text = '', response;
  let deltas = 0, completed = false;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = outcome => {
    if (ended) return;
    ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    resolveFirst(false);
    resolveDone({ outcome, deltas, completed, unicode_ok: text === 'relay-ok 中文' });
  };
  const req = http.request(origin + '/openai/v1/responses?case=' + scenario, { method: 'POST', agent: false,
    headers: { Authorization: 'Bearer ' + MOCK_RELAY_TOKEN, 'Content-Type': 'application/json' } }, res => {
    response = res;
    if (res.statusCode !== 200 || !res.headers['content-type']?.includes('text/event-stream')) {
      finish('invalid_stream'); req.destroy(); return;
    }
    res.setEncoding('utf8');
    res.on('data', chunk => {
      if (ended) return;
      pending += chunk;
      if (pending.length > 16384) { finish('invalid_stream'); req.destroy(); return; }
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      try {
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5));
          if (event.type === 'response.output_text.delta') {
            ensure(typeof event.delta === 'string', 'invalid_stream');
            deltas++; if (scenario === 'stream') text = (text + event.delta).slice(0, 64);
            resolveFirst(true);
          } else if (event.type === 'response.completed') completed = true;
          else if (event.type === 'error' || event.type === 'response.failed') { finish('invalid_stream'); req.destroy(); }
        }
      } catch { finish('invalid_stream'); req.destroy(); }
    });
    res.on('end', () => finish(completed ? 'completed' : 'interrupted'));
    res.on('error', () => finish('interrupted'));
    res.on('aborted', () => finish('interrupted'));
  });
  const abort = () => { finish('cancelled'); req.destroy(); response?.destroy(); };
  timer = setTimeout(() => { finish('timeout'); req.destroy(); response?.destroy(); }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  req.on('error', () => finish('interrupted'));
  if (signal?.aborted) abort();
  else req.end('{}'); // Synthetic input only; never copy user prompts or credentials.
  return { first, done, abort };
}

async function within(promise, ms, reason) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CheckFailure(reason)), ms);
  })]); } finally { clearTimeout(timer); }
}

export async function checkClientLifecycle(config, { interruptSsh = false } = {}, {
  signals = process, spawnProcess = spawn, logger = console.log, timeoutMs = 90000,
  stepMs = 30000, pollMs = 250, requestMs = 4000, quietMs = 400, tunnelPause,
} = {}) {
  const report = { ...versionInfo(), platform: process.platform, arch: process.arch,
    scope: 'mock_client_inner_ssh', mock: true, status: 'running', checks: [], ssh_events: [],
    not_checked: ['publisher_outer_recovery', 'real_network_failure', 'host_key_change', 'authentication_failure', 'real_hai'] };
  const controller = new AbortController(), tunnelSignals = new EventEmitter();
  const origin = 'http://127.0.0.1:' + config.localPort;
  let child, tunnel, tunnelEnded = false, tunnelExit, started = false, successfulReads = 0, userOrDeadlineStop = false;
  const stop = () => { userOrDeadlineStop = true; controller.abort(); tunnelSignals.emit('SIGTERM'); };
  const timer = setTimeout(stop, timeoutMs);
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  const check = async (id, action) => {
    const began = performance.now();
    try {
      const evidence = await action();
      const result = { id, status: 'pass', elapsed_ms: Math.round(performance.now() - began), ...(evidence ? { evidence } : {}) };
      report.checks.push(result); logger(JSON.stringify({ event: 'check', ...result }));
    } catch (error) {
      const result = { id, status: 'fail', reason: userOrDeadlineStop ? 'cancelled_or_deadline' : reasonOf(error) };
      report.checks.push(result); logger(JSON.stringify({ event: 'check', ...result })); throw error;
    }
  };
  const active = () => { ensure(!controller.signal.aborted, 'cancelled'); ensure(!tunnelEnded, 'ssh_ended_before_check'); };
  const stats = async () => {
    active();
    const data = await jsonRequest(origin, '/openai/v1/models', { signal: controller.signal, timeoutMs: requestMs });
    ensure(data.mock === true && data.data?.length === 1 && data.data[0].id === 'relay-ok', 'not_expected_mock');
    for (const field of ['requests', 'rejectedAuth', 'activeStreams', 'completedStreams', 'cancelledStreams']) {
      ensure(Number.isSafeInteger(data.stats?.[field]) && data.stats[field] >= 0, 'invalid_mock_stats');
    }
    successfulReads++;
    return data.stats;
  };
  const waitStats = async predicate => {
    const deadline = performance.now() + stepMs;
    while (performance.now() < deadline) {
      active();
      try { const value = await stats(); if (predicate(value)) return value; }
      catch (error) { if (reasonOf(error) !== 'http_unavailable') throw error; }
      await pause(pollMs, undefined, { signal: controller.signal });
    }
    throw new CheckFailure('mock_ready_or_cleanup_timeout');
  };
  const completedStream = async () => {
    active();
    const observation = await observeStream(origin, 'stream', { signal: controller.signal, timeoutMs: stepMs }).done;
    ensure(observation.outcome === 'completed' && observation.deltas === 3 && observation.unicode_ok, 'synthetic_sse_failed');
    return { deltas: observation.deltas, completed: true, unicode_ok: true };
  };
  try {
    await check('mock_config', async () => validateLifecycleConfig(config, interruptSsh));
    await check('free_port', async () => requireFreePort(config.localPort));
    active(); // No process is yet running; tunnelEnded is false.
    started = true;
    tunnel = runTunnel(config, { signals: tunnelSignals, logger: () => {},
      ...(tunnelPause ? { pause: tunnelPause } : {}),
      onEvent: event => { if (report.ssh_events.length < 200) report.ssh_events.push(event); },
      spawnProcess: (...args) => {
        child = spawnProcess(...args);
        const own = child;
        own.once('close', () => { if (child === own) child = undefined; });
        return own;
      } }).then(code => { tunnelEnded = true; tunnelExit = code; }, () => { tunnelEnded = true; tunnelExit = 1; });
    await check('mock_ready', async () => {
      const health = await waitStats(() => true);
      ensure(health.activeStreams === 0 && health.rejectedAuth === 0, 'mock_not_exclusive_or_auth_rejected');
      return { active_streams: 0, hai: 'not_checked' };
    });
    await check('unicode_sse', completedStream);
    if (interruptSsh) await check('inner_recovery', async () => {
      const before = await stats(), baseReads = successfulReads, eventsAtStart = report.ssh_events.length;
      ensure(before.activeStreams === 0, 'mock_not_exclusive');
      const stream = observeStream(origin, 'cancel', { signal: controller.signal, timeoutMs: stepMs });
      try {
        ensure(await stream.first, 'no_inflight_delta');
        const inflight = await stats();
        ensure(inflight.activeStreams === 1 && inflight.requests === before.requests + 2, 'mock_not_exclusive');
        const owned = child;
        ensure(owned && owned.exitCode == null && owned.kill('SIGTERM'), 'owned_ssh_interrupt_failed');
        const interrupted = await within(stream.done, Math.min(5000, stepMs), 'inflight_not_interrupted');
        ensure(interrupted.outcome === 'interrupted' && !interrupted.completed && interrupted.deltas >= 1, 'inflight_not_interrupted');
        let after = await waitStats(value => value.activeStreams === 0);
        await pause(quietMs, undefined, { signal: controller.signal });
        after = await stats();
        ensure(after.activeStreams === 0 && after.cancelledStreams === before.cancelledStreams + 1
          && after.completedStreams === before.completedStreams, 'cancelled_stream_not_cleaned');
        ensure(after.requests === before.requests + 1 + successfulReads - baseReads, 'unexpected_requests_or_replay');
        const events = report.ssh_events.slice(eventsAtStart);
        ensure(events.some(event => event.state === 'retry_wait') && events.some(event => event.state === 'starting'), 'no_automatic_ssh_retry_observed');
        return { inflight_interrupted: true, recovered: true, active_streams: 0, cancelled_delta: 1,
          observed_extra_requests: 0, stats_scope: 'exclusive_mock_window' };
      } finally { stream.abort(); }
    });
    else report.checks.push({ id: 'inner_recovery', status: 'skip', reason: 'interrupt_not_requested' });
    await check('new_request', completedStream);
    await check('final_quiet', async () => {
      const final = await waitStats(value => value.activeStreams === 0);
      ensure(final.rejectedAuth === 0, 'mock_auth_rejected');
      return { active_streams: 0, rejected_auth: 0 };
    });
  } catch (error) {
    if (!report.checks.some(check => check.status === 'fail')) {
      const failure = { id: 'run', status: 'fail', reason: userOrDeadlineStop ? 'cancelled_or_deadline' : reasonOf(error) };
      report.checks.push(failure); logger(JSON.stringify({ event: 'check', ...failure }));
    }
  }
  finally {
    clearTimeout(timer);
    controller.abort(); tunnelSignals.emit('SIGTERM');
    if (started) {
      try {
        await check('stop_owned_ssh', async () => {
          try { await within(tunnel, 5000, 'ssh_stop_timeout'); }
          catch (error) { child?.kill('SIGKILL'); await within(tunnel, 1000, 'ssh_stop_timeout'); throw error; }
          ensure(tunnelExit === 0 && report.ssh_events.at(-1)?.reason === 'user_stop', 'ssh_not_stopped_by_checker');
          return { child_stopped: true };
        });
      } catch {}
      try { await check('port_released', async () => requireFreePort(config.localPort)); } catch {}
    }
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
  for (const id of IDS) if (!report.checks.some(check => check.id === id)) {
    report.checks.push({ id, status: 'skip', reason: 'prerequisite_failed' });
  }
  report.status = report.checks.some(check => check.status === 'fail') ? 'fail'
    : report.checks.some(check => check.status === 'skip') ? 'partial' : 'pass';
  return report;
}

export async function runLifecycleChecks({ clientFile, out, interruptSsh = false }, {
  preflight = diagnoseOffline, ...dependencies
} = {}) {
  ensure(typeof out === 'string' && out && !/[\x00-\x1f\x7f]/.test(out), 'report_output_required');
  const config = await loadClientConfig(clientFile, {}); // Never use real credential environment overrides.
  validateLifecycleConfig(config, interruptSsh);
  const destination = path.resolve(out);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const file = await fs.open(destination, 'wx', 0o600); // Reserve before SSH; never overwrite any user file.
  try {
    const offline = await preflight({ file: clientFile }, { env: {} });
    const readyChecks = ['ssh.profile_static', 'hop_1.trust', 'hop_2.trust'];
    const missingReadyChecks = readyChecks.filter(id => !offline.checks?.some(check => check.id === id && check.status === 'pass'));
    if (offline.status === 'fail' || missingReadyChecks.length) {
      const report = { ...versionInfo(), platform: process.platform, scope: 'mock_client_inner_ssh', mock: true,
        status: 'fail', checks: [{ id: 'offline_preflight', status: 'fail', reason: 'offline_preflight_failed',
          failed_checks: [...new Set([...(offline.checks || []).filter(check => check.status === 'fail').map(check => check.id),
            ...missingReadyChecks])] }] };
      await file.writeFile(JSON.stringify(report, null, 2) + '\n');
      return { report, destination };
    }
    const report = await checkClientLifecycle(config, { interruptSsh }, dependencies);
    await file.writeFile(JSON.stringify(report, null, 2) + '\n');
    return { report, destination };
  } finally { await file.close(); }
}
