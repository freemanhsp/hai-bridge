import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { pipeline, Transform } from 'node:stream';
import { startDevelopment, DEV_TOKEN } from '../../src/dev.mjs';
import { stripHeaders } from '../../src/bridge.mjs';
import { validatePort } from '../../src/config.mjs';
import { SERVER_NAME } from './certificates.mjs';

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
  if (pair.server_name !== SERVER_NAME || !/^[a-f0-9]{64}$/.test(pair.server_pin)
      || !pair.ca || !pair.cert || !pair.key) throw new Error('Incomplete mock TLS trust');
  tls.createSecureContext({ ca: pair.ca, cert: pair.cert, key: pair.key, minVersion: 'TLSv1.3' });
  return { ca: pair.ca, cert: pair.cert, key: pair.key, servername: SERVER_NAME,
    rejectUnauthorized: true, minVersion: 'TLSv1.3', agent: false,
    checkServerIdentity(name, cert) {
      return tls.checkServerIdentity(name, cert)
        || (pinOf(cert) === pair.server_pin ? undefined : new Error('Application TLS pin mismatch'));
    } };
}

export async function startMockPublisher(pair, { port = 0, intervalMs = 150, idleTimeoutMs = 1200 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(pair.client_pin)) throw new Error('Missing pinned client identity');
  validatePort(port, 'application port', true);
  tls.createSecureContext({ ca: pair.ca, cert: pair.cert, key: pair.key, minVersion: 'TLSv1.3' });
  // Fixed synthetic upstream: no HAI configuration/environment credentials are consulted.
  const dev = await startDevelopment({ port: 0, intervalMs, idleTimeoutMs });
  const handler = dev.bridge.listeners('request')[0];
  const server = https.createServer({ key: pair.key, cert: pair.cert, ca: pair.ca,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    if (!req.socket.authorized || pinOf(req.socket.getPeerCertificate()) !== pair.client_pin) {
      req.socket.destroy();
      return;
    }
    handler(req, res);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  // Track handshakes too; closeAllConnections alone need not close incomplete TLS peers.
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let closing;
  const close = () => closing ||= (async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await dev.close();
  })();
  try { return { server, port: await listen(server, port), stats: dev.stats, close }; }
  catch (error) { await close(); throw error; }
}

export async function startMockClient(pair, { tlsPort, port = 0, idleTimeoutMs = 3000 } = {}) {
  validatePort(tlsPort, 'TLS tunnel port');
  const security = clientTlsOptions(pair);
  const outgoing = new Set();
  const server = http.createServer((req, res) => {
    // Explicitly mock-only: no production token can be used with this experimental adapter.
    if (req.headers.authorization !== 'Bearer ' + DEV_TOKEN) {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"mock_client_unauthorized"}}');
      return;
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')
        || /[\\%]/.test(req.url.split('?')[0]) || req.url.split('?')[0].split('/').includes('..')) {
      req.resume();
      res.writeHead(400).end();
      return;
    }
    const headers = stripHeaders(req.headers);
    headers.authorization = 'Bearer ' + DEV_TOKEN;
    headers.host = SERVER_NAME;
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 67108864 ? new Error('Request too large') : null, chunk);
    } });
    const fail = (code = 502) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(code, { 'content-type': 'application/json' }).end('{"error":{"code":"mock_tls_transport_failed"}}');
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
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
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

// Local test substitute for an opaque relay. It handles TCP bytes, never HTTP or TLS termination.
export async function startOpaqueRelay(targetPort, { port = 0, capture = false } = {}) {
  validatePort(targetPort, 'opaque target port');
  const sockets = new Set(), captured = [];
  let capturedBytes = 0;
  const server = net.createServer(incoming => {
    const outgoing = net.connect({ host: '127.0.0.1', port: targetPort });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
      socket.once('close', () => { sockets.delete(socket); incoming.destroy(); outgoing.destroy(); });
      if (capture) socket.on('data', chunk => {
        if (capturedBytes < 262144) { captured.push(chunk.subarray(0, 262144 - capturedBytes)); capturedBytes += chunk.length; }
      });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  const drop = () => { for (const socket of sockets) socket.destroy(); };
  let closing;
  const close = () => closing ||= (async () => { drop(); await closeServer(server); })();
  try { return { server, port: await listen(server, port), captured, drop, close }; }
  catch (error) { await close(); throw error; }
}
