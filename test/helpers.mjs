import http from 'node:http';
import { once } from 'node:events';
import { createBridge } from '../src/bridge.mjs';

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

export async function close(server) {
  const done = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await done;
}

export async function fixture(t, handler, overrides = {}) {
  const upstream = http.createServer(handler);
  const upstreamUrl = await listen(upstream);
  const token = 'b'.repeat(43), key = 'hai-test-key', logs = [];
  const bridge = createBridge({ upstream: upstreamUrl, getBridgeToken: async () => token,
    getUpstreamKey: async () => key, logger: event => logs.push(event), ...overrides });
  const origin = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  return { origin, upstreamUrl, upstream, bridge, token, key, logs, headers: { Authorization: `Bearer ${token}` } };
}

export async function rawRequest(url, { method = 'GET', headers = {}, body, chunks, target } = {}) {
  return await new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, ...(target ? { path: target } : {}) }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (chunks) { chunks.forEach(chunk => req.write(chunk)); req.end(); }
    else req.end(body);
  });
}
