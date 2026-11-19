import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createBridge } from '../../src/bridge.mjs';
import { validatePort } from '../../src/config.mjs';

// Public fixture values, NOT real credentials. Never read HAI config or env keys.
export const MOCK_TOKEN = 'hai_bridge_public_mock_token_20261119';
const MOCK_KEY = 'mock-upstream-not-a-real-hai-key';

async function listen(server, port) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

export async function startMockRelay({ port = 18080, intervalMs = 1000, idleTimeoutMs = 5000, logger = () => {} } = {}) {
  validatePort(port, 'mock bridge port', true);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid mock interval');
  const windowsChecks = await readFile(new URL('./windows-checks.ps1', import.meta.url), 'utf8');
  const stats = { requests: 0, rejectedAuth: 0, activeStreams: 0, completedStreams: 0, cancelledStreams: 0 };
  const upstream = http.createServer((req, res) => {
    stats.requests++;
    if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) {
      stats.rejectedAuth++;
      req.resume();
      res.writeHead(401).end();
      return;
    }
    // Discard input; do not retain or log request bodies/headers.
    req.resume();
    req.once('end', () => {
      if (res.destroyed) return;
      const url = new URL(req.url, 'http://mock.invalid');
      if (req.method === 'GET' && url.pathname === '/openai/v1/models') {
        if (url.searchParams.get('artifact') === 'windows-checks') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(windowsChecks);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'relay-ok', object: 'model' }], mock: true, stats }));
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/openai/v1/responses') {
        res.writeHead(404).end();
        return;
      }
      const scenario = url.searchParams.get('case') || 'stream';
      if (scenario === 'stall') return;
      if (scenario === 'disconnect') { res.destroy(); return; }
      if (scenario === '429' || scenario === '503') {
        res.writeHead(Number(scenario), { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: { code: `mock_${scenario}` } }));
        return;
      }
      if (scenario === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mock: true, output: 'relay-ok 中文' }));
        return;
      }
      if (!['stream', 'cancel'].includes(scenario)) { res.writeHead(400).end(); return; }

      stats.activeStreams++;
      let index = 0, timer;
      res.on('finish', () => { stats.completedStreams++; });
      res.on('close', () => {
        clearTimeout(timer);
        stats.activeStreams--;
        if (!res.writableFinished) stats.cancelledStreams++;
        logger({ event: 'mock_stream_closed', completed: res.writableFinished, active_streams: stats.activeStreams });
      });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.flushHeaders();
      const emit = () => {
        if (res.destroyed) return;
        const limit = scenario === 'cancel' ? 60 : 3;
        if (index === limit) {
          res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', mock: true } }) + '\n\n');
          return;
        }
        const delta = scenario === 'cancel' ? `mock-tick-${index}` : ['relay-', 'ok', ' 中文'][index];
        res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta }) + '\n\n');
        index++;
        timer = setTimeout(emit, intervalMs);
      };
      emit();
    });
  });
  let bridge;
  try {
    const upstreamOrigin = await listen(upstream, 0);
    bridge = createBridge({ upstream: upstreamOrigin, idleTimeoutMs,
      getBridgeToken: async () => MOCK_TOKEN, getUpstreamKey: async () => MOCK_KEY, logger });
    const origin = await listen(bridge, port);
    return { origin, upstreamOrigin, bridge, upstream, stats, close: async () => { await close(bridge); await close(upstream); } };
  } catch (error) {
    if (bridge) await close(bridge);
    await close(upstream);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const relay = await startMockRelay({ logger: event => console.log(JSON.stringify(event)) });
    console.log(`MOCK ONLY: actual bridge at ${relay.origin}; synthetic upstream at ${relay.upstreamOrigin}`);
    console.log('No HAI credentials, real model calls, or automatic request retries. Ctrl-C stops both servers.');
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      relay.close().catch(() => { process.exitCode = 1; });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(`Mock relay startup failed: ${error.code || 'configuration_error'}`);
    process.exitCode = 1;
  }
}
