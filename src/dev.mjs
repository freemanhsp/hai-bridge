import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createBridge } from './bridge.mjs';
import { validatePort, writePrivateFile } from './config.mjs';

export const DEFAULT_DEV_PORT = 18090;
export const DEV_TOKEN = 'hai_bridge_public_dev_token_20261120';
const DEV_KEY = 'public-dev-upstream-fixture-only';

async function listen(server, port) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  const done = new Promise(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}

export async function startDevelopment({ port = DEFAULT_DEV_PORT, out, intervalMs = 500,
  idleTimeoutMs = 5000, logger = () => {} } = {}, { writeConfig = writePrivateFile } = {}) {
  validatePort(port, 'dev port', true);
  for (const [label, value] of [['intervalMs', intervalMs], ['idleTimeoutMs', idleTimeoutMs]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid dev ' + label);
  }
  if (out !== undefined && (typeof out !== 'string' || !out || /[\x00-\x1f\x7f]/.test(out))) {
    throw new Error('Invalid dev output path');
  }
  const destination = out === undefined ? undefined : path.resolve(out);
  if (destination) {
    try { await fs.lstat(destination); throw Object.assign(new Error('Dev output already exists'), { code: 'EEXIST' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const stats = { requests: 0, rejectedAuth: 0, activeStreams: 0, completedStreams: 0, cancelledStreams: 0 };
  const upstream = http.createServer((req, res) => {
    stats.requests++;
    if (req.headers.authorization !== 'Bearer ' + DEV_KEY) {
      stats.rejectedAuth++;
      req.resume();
      res.writeHead(401).end();
      return;
    }
    // Synthetic output only: input is discarded, never retained, echoed or logged.
    req.resume();
    req.once('end', () => {
      if (res.destroyed) return;
      let target;
      try { target = new URL(req.url, 'http://mock.invalid'); }
      catch { res.writeHead(400).end(); return; }
      if (req.method === 'GET' && target.pathname === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'relay-ok', object: 'model' }], mock: true, stats }));
        return;
      }
      if (req.method !== 'POST' || target.pathname !== '/openai/v1/responses') { res.writeHead(404).end(); return; }
      const scenario = target.searchParams.get('case') || 'stream';
      if (scenario === 'stall') return;
      if (scenario === 'disconnect') { res.destroy(); return; }
      if (scenario === '429' || scenario === '503') {
        res.writeHead(Number(scenario), { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: { code: 'mock_' + scenario } }));
        return;
      }
      if (scenario === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mock: true, output: 'relay-ok 中文' }));
        return;
      }
      if (!['stream', 'cancel'].includes(scenario)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'mock_case_not_supported' } }));
        return;
      }
      stats.activeStreams++;
      let index = 0, timer;
      res.on('finish', () => { stats.completedStreams++; });
      res.on('close', () => {
        clearTimeout(timer);
        stats.activeStreams--;
        if (!res.writableFinished) stats.cancelledStreams++;
        logger({ event: 'dev_stream_closed', completed: res.writableFinished, active_streams: stats.activeStreams });
      });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.flushHeaders();
      const emit = () => {
        if (res.destroyed) return;
        if (scenario === 'stream' && index === 3) {
          res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', mock: true,
            usage: { input_tokens: 0, output_tokens: 0 } } }) + '\n\n');
          return;
        }
        const delta = scenario === 'cancel' ? 'mock-tick-' + index : ['relay-', 'ok', ' 中文'][index];
        res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta }) + '\n\n');
        index++;
        timer = setTimeout(emit, intervalMs);
      };
      emit();
    });
  });
  let bridge, tempDirectory, clientFile, configCreated = false;
  const removeTemporaryConfig = async () => {
    if (!tempDirectory) return;
    if (configCreated) {
      await fs.unlink(clientFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      configCreated = false;
    }
    // Never recursively delete unexpected files somebody may have put in this directory.
    await fs.rmdir(tempDirectory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
  try {
    const upstreamOrigin = await listen(upstream, 0);
    bridge = createBridge({ upstream: upstreamOrigin, idleTimeoutMs,
      getBridgeToken: async () => DEV_TOKEN, getUpstreamKey: async () => DEV_KEY, logger });
    const origin = await listen(bridge, port);
    if (!destination) tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-bridge-dev-'));
    clientFile = destination || path.join(tempDirectory, 'client.json');
    await writeConfig(clientFile, JSON.stringify({ bridge_token: DEV_TOKEN, model: 'relay-ok',
      local_only: true, ssh_target: 'dev-local-only', local_port: bridge.address().port,
      remote_host: '127.0.0.1', remote_port: bridge.address().port, reconnect: false, max_retries: 0 }, null, 2) + '\n');
    configCreated = true;
    let closing;
    const close = () => closing ||= (async () => {
      await closeServer(bridge);
      await closeServer(upstream);
      await removeTemporaryConfig();
    })();
    return { origin, upstreamOrigin, clientFile, temporary: !destination, bridge, upstream, stats, close };
  } catch (error) {
    await closeServer(bridge);
    await closeServer(upstream);
    await removeTemporaryConfig().catch(() => {});
    throw error;
  }
}

function quotedArgument(value, platform) {
  return "'" + value.replaceAll("'", platform === 'win32' ? "''" : "'\"'\"'") + "'";
}

export function formatDevelopmentReady(service, platform = process.platform) {
  const configArg = quotedArgument(service.clientFile, platform);
  return ['MOCK ONLY: real bridge at ' + service.origin + '; synthetic loopback upstream.',
    (service.temporary ? 'Temporary' : 'Persistent') + ' client config: ' + service.clientFile,
    'node bin/hai-bridge.mjs doctor --client-config ' + configArg,
    'node bin/hai-bridge.mjs probe --client-config ' + configArg + ' --infer --model relay-ok',
    'No SSH, HAI credentials or real model calls. Use synthetic input only. Ctrl-C stops both owned servers.'].join('\n');
}

export async function runDevelopment(options = {}, { signals = process, logger = console.log, json = false,
  start = startDevelopment } = {}) {
  let service, stopRequested = false, resolveStop, phase = 'startup';
  const stopSignal = new Promise(resolve => { resolveStop = resolve; });
  const stop = () => { stopRequested = true; resolveStop(); };
  const emit = event => logger(json ? JSON.stringify(event) : 'Development servers stopped');
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    service = await start(options);
    if (!stopRequested) logger(json ? JSON.stringify({ event: 'dev', state: 'ready', mock: true,
      origin: service.origin, client_config: service.clientFile, temporary: service.temporary }) : formatDevelopmentReady(service));
    phase = 'stop';
    await stopSignal;
    await service.close();
    emit({ event: 'dev', state: 'stopped', mock: true });
    return 0;
  } catch (error) {
    if (json) logger(JSON.stringify({ event: 'dev', state: 'failed', mock: true,
      reason: phase === 'stop' ? 'cleanup_error' : ['EADDRINUSE', 'EEXIST', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'startup_error' }));
    const hint = phase === 'stop' ? 'Development cleanup failed; inspect the owned temporary configuration.'
      : error.code === 'EADDRINUSE' ? 'Dev loopback port is occupied; use --port 0 or another port. No existing listener was stopped.'
      : error.code === 'EEXIST' ? 'Dev output already exists; omit --out for a new temporary config or choose another path.'
      : ['EACCES', 'EPERM'].includes(error.code) ? 'Cannot start dev servers or write dev configuration; check local permissions.'
      : 'Cannot start the local dev environment; check port and output options.';
    throw new Error(hint);
  } finally {
    try { await service?.close().catch(() => {}); }
    finally { signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop); }
  }
}
