import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { pipeline, Transform } from 'node:stream';
import { startDevelopment, DEV_TOKEN } from './dev.mjs';
import { createBridge, stripHeaders, tokenMatches } from './bridge.mjs';
import { validatePort, validateToken } from './config.mjs';
import { SERVER_NAME, HAI_SERVER_NAME, EXPERIMENT, HAI_PAIRING } from './app-identity.mjs';
import { applicationCredentialReaders } from './app-config.mjs';

const pinOf = cert => createHash('sha256').update(cert.raw).digest('hex');
export async function listen(server, port = 0) {
  validatePort(port, 'experimental loopback port', true);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

export async function closeServer(server) {
  if (!server?.listening) return;
  const done = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}

export function clientTlsOptions(pair) {
  if (!((pair.server_name === SERVER_NAME && pair.experiment === EXPERIMENT)
      || (pair.server_name === HAI_SERVER_NAME && pair.experiment === HAI_PAIRING))
      || !/^[a-f0-9]{64}$/.test(pair.server_pin) || !pair.ca || !pair.cert || !pair.key) throw new Error('Incomplete application TLS trust');
  tls.createSecureContext({ ca: pair.ca, cert: pair.cert, key: pair.key, minVersion: 'TLSv1.3' });
  return { ca: pair.ca, cert: pair.cert, key: pair.key, servername: pair.server_name,
    rejectUnauthorized: true, minVersion: 'TLSv1.3', agent: false,
    checkServerIdentity(name, cert) {
      return tls.checkServerIdentity(name, cert)
        || (pinOf(cert) === pair.server_pin ? undefined : new Error('Application TLS pin mismatch'));
    } };
}

export async function startMockPublisher(pair, { port = 0, intervalMs = 150, idleTimeoutMs = 1200 } = {}) {
  if (pair.experiment !== EXPERIMENT || pair.server_name !== SERVER_NAME) throw new Error('Mock publisher requires an isolated mock pair');
  const dev = await startDevelopment({ port: 0, intervalMs, idleTimeoutMs });
  try { return await startTlsPublisher(pair, dev.bridge.listeners('request')[0], { port, stats: dev.stats, close: dev.close, idleTimeoutMs: 5000 }); }
  catch (error) { await dev.close(); throw error; }
}

export async function startHaiPublisher(pair, { port = 0, config } = {}) {
  if (pair.experiment !== HAI_PAIRING || pair.server_name !== HAI_SERVER_NAME
      || config?.mode !== 'hai') throw new Error('HAI publisher requires a dedicated real pairing and configuration');
  const readers = applicationCredentialReaders(config);
  await readers.getBridgeToken(); await readers.getUpstreamKey();
  const bridge = createBridge({ upstream: config.upstream, providers: ['openai'], ...readers });
  return startTlsPublisher(pair, bridge.listeners('request')[0], { port, idleTimeoutMs: 120000 });
}

async function startTlsPublisher(pair, handler, { port, stats, close: closeUpstream = async () => {}, idleTimeoutMs }) {
  if (!/^[a-f0-9]{64}$/.test(pair.client_pin)) throw new Error('Missing pinned client identity');
  validatePort(port, 'application port', true);
  tls.createSecureContext({ ca: pair.ca, cert: pair.cert, key: pair.key, minVersion: 'TLSv1.3' });
  const server = https.createServer({ key: pair.key, cert: pair.cert, ca: pair.ca,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    if (!req.socket.authorized || pinOf(req.socket.getPeerCertificate()) !== pair.client_pin) {
      req.socket.destroy();
      return;
    }
    handler(req, res);
  });
  server.requestTimeout = idleTimeoutMs;
  server.headersTimeout = Math.min(60000, idleTimeoutMs);
  // Track handshakes too; closeAllConnections alone need not close incomplete TLS peers.
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let closing;
  const close = () => closing ||= (async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await closeUpstream();
  })();
  try { return { server, port: await listen(server, port), stats, close }; }
  catch (error) { await close(); throw error; }
}

export async function startMockClient(pair, { tlsPort, port = 0, idleTimeoutMs = 3000 } = {}) {
  if (pair.experiment !== EXPERIMENT || pair.server_name !== SERVER_NAME) throw new Error('Mock client requires an isolated mock pair');
  return startApplicationClient(pair, { tlsPort, port, idleTimeoutMs, token: DEV_TOKEN });
}

export async function startHaiClient(pair, { tlsPort, port = 0, idleTimeoutMs = 120000, token } = {}) {
  if (pair.experiment !== HAI_PAIRING || pair.server_name !== HAI_SERVER_NAME || token === DEV_TOKEN) throw new Error('HAI client requires a dedicated real pairing and private token');
  return startApplicationClient(pair, { tlsPort, port, idleTimeoutMs, token });
}

async function startApplicationClient(pair, { tlsPort, port, idleTimeoutMs, token }) {
  validateToken(token);
  validatePort(tlsPort, 'TLS tunnel port');
  const security = clientTlsOptions(pair);
  const outgoing = new Set();
  const server = http.createServer((req, res) => {
    if (!tokenMatches(req.headers.authorization, 'Bearer ' + token)) {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"application_client_unauthorized"}}');
      return;
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')
        || /[\\%]/.test(req.url.split('?')[0]) || req.url.split('?')[0].split('/').includes('..')) {
      req.resume();
      res.writeHead(400).end();
      return;
    }
    const headers = stripHeaders(req.headers);
    headers.authorization = 'Bearer ' + token;
    headers.host = pair.server_name;
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 67108864 ? new Error('Request too large') : null, chunk);
    } });
    const fail = (code = 502) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(code, { 'content-type': 'application/json' }).end('{"error":{"code":"application_tls_transport_failed"}}');
    };
    const upstream = https.request({ ...security, hostname: '127.0.0.1', port: tlsPort,
      path: req.url, method: req.method, headers }, reply => {
      if (res.destroyed) { reply.destroy(); return; }
      res.writeHead(reply.statusCode, stripHeaders(reply.headers, true));
      res.flushHeaders();
      pipeline(reply, res, () => {});
    });
    outgoing.add(upstream);
    upstream.once('close', () => outgoing.delete(upstream));
    // Absolute connection/handshake deadline in addition to the stream idle timeout.
    const deadline = setTimeout(() => { fail(504); upstream.destroy(); }, idleTimeoutMs);
    upstream.on('socket', socket => socket.once('secureConnect', () => clearTimeout(deadline)));
    upstream.once('close', () => clearTimeout(deadline));
    upstream.setTimeout(idleTimeoutMs, () => { fail(504); upstream.destroy(); });
    upstream.on('error', () => { fail(); cancel(); req.resume(); });
    const cancel = () => { req.unpipe(limiter); limiter.destroy(); upstream.destroy(); };
    limiter.on('error', () => { fail(413); cancel(); req.resume(); });
    req.on('aborted', cancel);
    req.on('error', cancel);
    res.on('close', () => { if (!res.writableFinished) cancel(); });
    req.pipe(limiter).pipe(upstream);
  });
  server.requestTimeout = idleTimeoutMs;
  server.headersTimeout = Math.min(60000, idleTimeoutMs);
  let closing;
  const close = () => closing ||= (async () => {
    for (const req of outgoing) req.destroy();
    await closeServer(server);
  })();
  try {
    const localPort = await listen(server, port);
    return { server, port: localPort, origin: 'http://127.0.0.1:' + localPort, close };
  } catch (error) { await close(); throw error; }
}
