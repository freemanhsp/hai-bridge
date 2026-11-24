import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { sign } from 'node:crypto';
import { createBridge } from './bridge.mjs';
import { startDevelopment, DEV_KEY } from './dev.mjs';
import { startApplicationClient, listen, closeServer } from './app-transport.mjs';
import { readHaiKey } from './app-config.mjs';
import { deviceTlsOptions, renewServerIdentity, loadServerIdentity } from './device-identity.mjs';
import { createDeviceAuthority, challengeBytes, validateChallenge, remainingDeviceLifetime } from './device-auth.mjs';
import { enrollmentRequest, validateInvitation } from './device-registry.mjs';
import { readPrivateJson, exactObject } from './device-store.mjs';

export function deviceControlRequest(trust, port, route, body, { signal, timeoutMs = 10000, onServerTime } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({ ...deviceTlsOptions(trust), hostname: '127.0.0.1', port, method: 'POST', path: route, signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let size = 0, chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 16384) req.destroy(new Error('Device control response too large')); else chunks.push(chunk); });
      res.once('error', reject);
      res.once('end', () => {
        if (res.statusCode !== 200) { reject(new Error('Device authentication refused; check approval, trust and A availability')); return; }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('Invalid device control response')); return; }
        try {
          if (onServerTime) {
            const date = res.headers.date, time = typeof date === 'string' ? Date.parse(date) : NaN;
            if (!Number.isSafeInteger(time) || date !== new Date(time).toUTCString()) {
              throw Object.assign(new Error('Authenticated device server time missing or invalid'), { code: 'DEVICE_SERVER_TIME_INVALID' });
            }
            onServerTime(time);
          }
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Device control deadline exceeded')), timeoutMs);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject);
    req.end(payload);
  });
}
export async function startDevicePublisher(pair, { port = 0, config, intervalMs = 150, idleTimeoutMs,
  authOptions = {}, logger = () => {} } = {}) {
  const directory = config.deviceDirectory;
  const identity = await renewServerIdentity(directory);
  if (identity.trust.instance_id !== pair.trust.instance_id || identity.trust.mode !== config.mode) throw new Error('Device publisher identity changed');
  const authority = createDeviceAuthority(directory, identity.trust, { ...authOptions, logger });
  let development, server, closing, renewing = false, healthy = true, timer, refreshDone;
  const sockets = new Set();
  const close = () => closing ||= (async () => {
    clearInterval(timer); authority.close();
    for (const socket of sockets) socket.destroy();
    await refreshDone;
    await closeServer(server); await development?.close();
  })();
  try {
    if (config.mode === 'mock') development = await startDevelopment({ port: 0, intervalMs, idleTimeoutMs: idleTimeoutMs ?? 1200 });
    // The mock's token remains synthetic; real auth is read ONLY after current device authorization.
    const bridge = createBridge({ upstream: development?.upstreamOrigin ?? config.upstream, providers: ['openai'],
      idleTimeoutMs: idleTimeoutMs ?? (config.mode === 'mock' ? 1200 : 120000), logger,
      authorize: (req, res) => healthy ? authority.authorize(req, res) : false,
      getUpstreamKey: development ? async () => DEV_KEY : () => readHaiKey(config.authFile) });
    const handler = bridge.listeners('request')[0];
    server = https.createServer({ cert: identity.cert, key: identity.key, minVersion: 'TLSv1.3', requestCert: false }, (req, res) => {
      if (!healthy) { req.resume(); res.writeHead(503).end(); return; }
      if (!authority.handleControl(req, res)) handler(req, res);
    });
    server.requestTimeout = 120000; server.headersTimeout = 10000; server.maxConnections = 64;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    async function refreshCertificate({ force = false } = {}) {
      if (renewing || closing) return;
      renewing = true;
      let complete; refreshDone = new Promise(resolve => { complete = resolve; });
      try {
        const renewed = await renewServerIdentity(directory, { force });
        if (renewed.renewed) { server.setSecureContext({ cert: renewed.cert, key: renewed.key, minVersion: 'TLSv1.3' }); logger({ event: 'device_tls', state: 'server_certificate_renewed' }); }
        if (renewed.rootExpires - Date.now() < 30 * 86400000) logger({ event: 'device_tls', state: 'root_rotation_required_soon' });
      } catch {
        logger({ event: 'device_tls', state: 'renewal_unavailable' });
        // A temporary writer lock need not break a still-valid leaf. Invalid trust fails closed.
        try { await loadServerIdentity(directory); }
        catch { healthy = false; authority.close(); for (const socket of sockets) socket.destroy(); }
      } finally { renewing = false; complete(); }
    }
    const actualPort = await listen(server, port);
    if (identity.rootExpires - Date.now() < 30 * 86400000) logger({ event: 'device_tls', state: 'root_rotation_required_soon' });
    timer = setInterval(() => { void refreshCertificate(); }, 60000); timer.unref();
    return { server, port: actualPort, stats: development?.stats, authority, refreshCertificate, close };
  } catch (error) { await close(); throw error; }
}
export async function startDeviceClient(pair, { port = 0, tlsPort, token, config, idleTimeoutMs = 120000,
  now = Date.now, monotonic = () => performance.now(), request = deviceControlRequest } = {}) {
  const { trust, identity } = pair;
  const abort = new AbortController();
  let cached, authenticating;
  async function timedControl(route, body) {
    const startedAt = monotonic();
    let serverTime;
    const value = await request(trust, tlsPort, route, body, { signal: abort.signal, onServerTime(time) { serverTime = time; } });
    const receivedAt = monotonic();
    return { value, timing: { serverTime, elapsedMs: receivedAt - startedAt }, receivedAt, wallAt: now() };
  }
  async function getAuthorization() {
    if (cached) {
      const wallElapsed = now() - cached.wallAt, elapsed = monotonic() - cached.receivedAt;
      // Relative B clocks only: wall elapsed also detects sleep when a platform's
      // monotonic clock pauses; disagreement/backwards jumps invalidate the cache.
      if (wallElapsed >= 0 && elapsed >= 0 && Math.abs(wallElapsed - elapsed) <= 1000
          && wallElapsed < cached.refreshAfter && elapsed < cached.refreshAfter) return 'Bearer ' + cached.session_token;
      cached = undefined;
    }
    if (!authenticating) authenticating = (async () => {
      const challengeReply = await timedControl('/bridge/v2/challenge', { instance_id: trust.instance_id, device_id: identity.device_id });
      const challenge = validateChallenge(challengeReply.value, trust.instance_id, identity.device_id, challengeReply.timing);
      const sessionReply = await timedControl('/bridge/v2/session', { instance_id: trust.instance_id, device_id: identity.device_id,
        challenge_id: challenge.challenge_id, signature: sign(null, challengeBytes(challenge), identity.key).toString('base64url') });
      const session = sessionReply.value;
      exactObject(session, ['session_token', 'expires_at']);
      if (!/^[A-Za-z0-9_-]{43}$/.test(session.session_token)) throw new Error('Invalid device session');
      const remaining = remainingDeviceLifetime(session.expires_at, sessionReply.timing, 600000);
      cached = { session_token: session.session_token, receivedAt: sessionReply.receivedAt, wallAt: sessionReply.wallAt,
        refreshAfter: remaining - Math.min(30000, remaining / 10) };
      return 'Bearer ' + cached.session_token;
    })().finally(() => { authenticating = undefined; });
    return authenticating;
  }
  const service = await startApplicationClient({ server_name: trust.server_name }, { port, tlsPort, token, idleTimeoutMs,
    security: deviceTlsOptions(trust), getAuthorization,
    allowRequest: req => !req.url.startsWith('/bridge/'),
    onUnauthorized(authorization) { if (authorization === 'Bearer ' + cached?.session_token) cached = undefined; },
    closeExtra() { abort.abort(); cached = undefined; } });
  service.enroll = async () => {
    const file = path.join(config.deviceDirectory, 'invitation.json');
    const invite = validateInvitation(await readPrivateJson(file, 24000));
    if (JSON.stringify(invite.trust) !== JSON.stringify(trust)) throw new Error('Enrollment trust changed');
    const result = await request(trust, tlsPort, '/bridge/v2/enroll', enrollmentRequest(invite, identity, identity.label), { signal: abort.signal });
    if (result.device_id !== identity.device_id || !['pending', 'approved'].includes(result.state)) throw new Error('Invalid enrollment response');
    // The transferred invitation is no longer needed after A has the public key. Never delete the user's source invitation.
    await fs.unlink(file);
    return { device_id: identity.device_id, state: result.state };
  };
  return service;
}
