import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { DEV_TOKEN } from './dev.mjs';
import { clientTlsOptions, startMockClient, listen, closeServer } from './app-transport.mjs';
import { SERVER_NAME, EXPERIMENT } from './app-identity.mjs';

const auth = { authorization: 'Bearer ' + DEV_TOKEN };
export function request(origin, route, { method = 'GET', headers = auth, body, security, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const isTls = security !== undefined;
    const target = new URL(origin);
    const req = (isTls ? https : http).request({ hostname: target.hostname, port: target.port,
      path: route, method, headers, agent: false, ...(security || {}) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Probe deadline')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

export function stream(origin, scenario = 'stream') {
  let req, response, finished = false, resolveStarted, rejectStarted, resolveDone;
  let received = '', firstAt, lastAt, sawDelta = false;
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  // Attach a rejection handler immediately: failures before awaiting started must not be unhandled.
  started.catch(() => {});
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = complete => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (!sawDelta) rejectStarted(new Error('No mock stream delta'));
    resolveDone({ complete, received, firstAt, lastAt, sawDelta });
  };
  req = http.request(origin + '/openai/v1/responses?case=' + scenario, { method: 'POST', headers: auth, agent: false }, res => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', chunk => {
      received += chunk;
      if (received.includes('response.output_text.delta')) {
        firstAt ??= performance.now();
        lastAt = performance.now();
        sawDelta = true;
        resolveStarted();
      }
    });
    res.on('end', () => finish(res.statusCode === 200));
    res.on('error', () => finish(false));
    res.on('close', () => { if (!res.complete) finish(false); });
  });
  const timer = setTimeout(() => { req.destroy(); response?.destroy(); finish(false); }, 8000);
  req.on('error', () => finish(false));
  req.end('{}');
  return { started, done, cancel() { req.destroy(); response?.destroy(); finish(false); } };
}

export async function portFree(port) {
  const server = net.createServer();
  await listen(server, port);
  await closeServer(server);
}

export async function runChecks(pair, tlsPort, { interrupt, restore, evidence = 'local-tcp', logger = () => {},
  shouldStop = () => false, clientService } = {}) {
  const results = [];
  let client, baseline, trustedFixture = false;
  const run = async (name, action) => {
    if (shouldStop() && name !== 'owned-client-stop-releases-port') {
      results.push({ check: name, status: 'not-run' });
      return false;
    }
    try { await action(); results.push({ check: name, status: 'pass' }); logger('PASS ' + name); return true; }
    catch { results.push({ check: name, status: 'fail' }); logger('FAIL ' + name); return false; }
  };
  const get = (route, options) => request(client.origin, route, options);
  const models = async () => {
    if (shouldStop()) throw new Error('Experiment interrupted');
    const reply = await get('/openai/v1/models');
    assert.equal(reply.status, 200);
    const payload = JSON.parse(reply.body);
    assert.equal(payload.mock, true);
    assert.equal(payload.data[0].id, 'relay-ok');
    for (const field of ['requests', 'activeStreams', 'completedStreams', 'cancelledStreams']) {
      assert.ok(Number.isSafeInteger(payload.stats[field]) && payload.stats[field] >= 0);
    }
    return payload.stats;
  };
  const cleaned = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const stats = await models();
      if (stats.activeStreams === 0) return stats;
      await pause(100);
    }
    throw new Error('Mock cancellation did not clean up');
  };
  const noUpstream = async action => {
    const before = await models();
    await action();
    const after = await models();
    assert.equal(after.requests, before.requests + 1);
  };
  try {
    client = clientService || await startMockClient(pair, { tlsPort });
    trustedFixture = await run('pinned-mtls-and-mock-identity', async () => {
      baseline = await models();
      assert.equal(baseline.activeStreams, 0, 'Other clients are using this dedicated experiment');
    });
    if (!trustedFixture) {
      // No POST before authenticating and confirming a mock service; include cleanup in the verdict.
      if (!clientService) {
        const port = client.port;
        await run('owned-client-stop-releases-port', async () => { await client.close(); await portFree(port); });
      }
      client = undefined;
      return report();
    }
    const secure = clientTlsOptions(pair), tlsOrigin = 'https://127.0.0.1:' + tlsPort;
    await run('missing-and-wrong-local-token', () => noUpstream(async () => {
      for (const headers of [{}, { authorization: 'Bearer mock-wrong' }]) {
        assert.equal((await get('/openai/v1/models', { headers })).status, 401);
      }
    }));
    await run('missing-client-certificate', () => noUpstream(async () => {
      const security = { ...secure }; delete security.cert; delete security.key;
      await assert.rejects(request(tlsOrigin, '/openai/v1/models', { security }));
    }));
    await run('wrong-server-pin', () => noUpstream(async () => {
      await assert.rejects(request(tlsOrigin, '/openai/v1/models', {
        security: clientTlsOptions({ ...pair, server_pin: '0'.repeat(64) }) }));
    }));
    await run('wrong-server-name', () => noUpstream(async () => {
      await assert.rejects(request(tlsOrigin, '/openai/v1/models', { security: { ...secure, servername: 'wrong.mock' } }));
    }));
    await run('wrong-ca', () => noUpstream(async () => {
      await assert.rejects(request(tlsOrigin, '/openai/v1/models', { security: { ...secure, ca: pair.cert } }));
    }));
    await run('plaintext-not-accepted-by-tls', () => noUpstream(async () => {
      // No auth/body is sent on this deliberately unencrypted negative probe.
      await assert.rejects(request('http://127.0.0.1:' + tlsPort, '/openai/v1/models', { headers: {} }));
    }));
    await run('bridge-token-at-a', () => noUpstream(async () => {
      assert.equal((await request(tlsOrigin, '/openai/v1/models', { security: secure, headers: {} })).status, 401);
    }));
    await run('route-and-method-limits', () => noUpstream(async () => {
      assert.equal((await get('/admin/exec')).status, 404);
      assert.equal((await get('/openai/v1/models', { method: 'POST', body: '{}' })).status, 405);
      assert.equal((await get('/openai/v1/%2e%2e/admin')).status, 400);
    }));
    await run('json-unicode', async () => {
      const reply = await get('/openai/v1/responses?case=json', { method: 'POST', body: '{}' });
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), { mock: true, output: 'relay-ok 中文' });
    });
    await run('unicode-sse-incremental', async () => {
      const active = stream(client.origin);
      const result = await active.done;
      assert.equal(result.complete, true);
      assert.ok(result.received.includes(' 中文') && result.received.includes('response.completed'));
      assert.ok(result.lastAt - result.firstAt >= 100, 'SSE must arrive over time, not one buffered response');
    });
    await run('four-concurrent-sse', async () => {
      const streams = Array.from({ length: 4 }, () => stream(client.origin));
      const replies = await Promise.all(streams.map(active => active.done));
      for (const reply of replies) assert.ok(reply.complete && reply.received.includes('response.completed'));
      assert.equal((await cleaned()).activeStreams, 0);
    });
    await run('cancel-cleans-up-upstream', async () => {
      const before = await models(), active = stream(client.origin, 'cancel');
      try { await active.started; } finally { active.cancel(); }
      assert.equal((await active.done).complete, false);
      const after = await cleaned();
      assert.equal(after.cancelledStreams, before.cancelledStreams + 1);
    });
    for (const status of [429, 503]) await run('status-' + status + '-no-replay', async () => {
      const before = await models();
      const reply = await get('/openai/v1/responses?case=' + status, { method: 'POST', body: '{}' });
      assert.equal(reply.status, status);
      assert.equal(reply.headers['retry-after'], '7');
      assert.equal(JSON.parse(reply.body).error.code, 'mock_' + status);
      assert.equal((await models()).requests, before.requests + 2);
    });
    await run('upstream-stall-and-disconnect', async () => {
      for (const [scenario, status] of [['stall', 504], ['disconnect', 502]]) {
        const before = await models();
        assert.equal((await get('/openai/v1/responses?case=' + scenario, { method: 'POST', body: '{}' })).status, status);
        assert.equal((await models()).requests, before.requests + 2);
      }
    });
    if (interrupt && restore) await run('owned-link-interruption-recovery-no-replay', async () => {
      const before = await models(), active = stream(client.origin, 'cancel');
      try {
        await active.started;
        await interrupt();
        assert.equal((await active.done).complete, false);
        await restore();
        // One immediate model query after restoration; retries here could hide an extra request.
        const after = await models();
        assert.equal(after.requests, before.requests + 2);
        assert.equal(after.activeStreams, 0);
        assert.equal(after.cancelledStreams, before.cancelledStreams + 1);
        const fresh = await stream(client.origin).done;
        assert.ok(fresh.complete && fresh.received.includes('response.completed'));
      } finally { active.cancel(); await restore(); }
    });
    else results.push({ check: 'owned-link-interruption-recovery-no-replay', status: 'not-run' });
    await run('final-health', async () => {
      assert.equal((await get('/healthz')).status, 200);
      assert.equal((await cleaned()).activeStreams, 0);
    });
  } finally {
    if (client && !clientService) {
      const port = client.port;
      await run('owned-client-stop-releases-port', async () => { await client.close(); await portFree(port); });
    }
  }
  return report();
  function report() {
    return { experiment: EXPERIMENT, mock: true, hai: 'not_called', evidence,
      platform: process.platform, node: process.versions.node,
      status: results.some(item => item.status === 'fail') ? 'fail'
        : results.some(item => item.status === 'not-run') ? 'partial' : 'pass', checks: results };
  }
}
