import { randomBytes } from 'node:crypto';
import { exactObject } from './device-store.mjs';
import { publicDeviceKey } from './device-identity.mjs';
import { digest, loadRegistry, registerDevice, validSignature } from './device-registry.mjs';

export function challengeBytes(challenge) {
  return Buffer.from(JSON.stringify(['hai-bridge-device-v2', 'session', challenge.instance_id, challenge.device_id,
    challenge.generation, challenge.challenge_id, challenge.nonce, challenge.expires_at]));
}
// HTTP Date comes from the pinned TLS peer, not B's wall clock. It has second
// precision: bound the advertised lifetime, then subtract rounding and the full
// control round trip from B's cache budget. A remains the expiry authority.
export function remainingDeviceLifetime(expiresAt, timing, maximumMs) {
  exactObject(timing, ['serverTime', 'elapsedMs']);
  if (![120000, 600000].includes(maximumMs) || !Number.isSafeInteger(timing.serverTime) || timing.serverTime < 0
      || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs < 0 || !Number.isSafeInteger(expiresAt)
      || expiresAt <= timing.serverTime + timing.elapsedMs || expiresAt > timing.serverTime + maximumMs + 1000) {
    throw Object.assign(new Error('Invalid device response lifetime'), { code: 'DEVICE_RESPONSE_LIFETIME_INVALID' });
  }
  return Math.max(0, expiresAt - timing.serverTime - timing.elapsedMs - 1000);
}
export function validateChallenge(challenge, instanceId, deviceId, timing) {
  exactObject(challenge, ['instance_id', 'device_id', 'generation', 'challenge_id', 'nonce', 'expires_at']);
  if (challenge.instance_id !== instanceId || challenge.device_id !== deviceId
      || !Number.isSafeInteger(challenge.generation) || challenge.generation < 1
      || !/^[A-Za-z0-9_-]{43}$/.test(challenge.challenge_id) || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)) throw new Error('Invalid session challenge');
  if (remainingDeviceLifetime(challenge.expires_at, timing, 120000) <= 0) throw new Error('Session challenge has no safe remaining lifetime');
  return challenge;
}
function json(res, status, value) {
  if (!res.destroyed) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || Number(req.headers['content-length'] || 0) > 16384) throw new Error('Invalid control body');
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Control body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// A memory holds only hashes of sessions; restarting A invalidates them. Registry is checked per request.
export function createDeviceAuthority(directory, trust, { now = Date.now, sessionMs = 600000, logger = () => {} } = {}) {
  if (!Number.isInteger(sessionMs) || sessionMs < 1000 || sessionMs > 600000) throw new Error('Invalid device session lifetime');
  const challenges = new Map(), sessions = new Map(), active = new Map(), pendingAuth = new Map();
  let windowStart = now(), controlCount = 0, controlActive = 0, stopped = false, polling = false, registryFailed = false;
  const prune = () => {
    for (const [key, value] of challenges) if (value.expires_at <= now()) challenges.delete(key);
    for (const [key, value] of sessions) if (value.expires_at <= now()) sessions.delete(key);
  };
  const approved = (state, id, generation) => state.devices.find(item => item.device_id === id && item.state === 'approved'
    && (generation === undefined || generation === item.generation));
  async function challenge(request) {
    exactObject(request, ['instance_id', 'device_id']);
    if (request.instance_id !== trust.instance_id || !/^[a-f0-9]{64}$/.test(request.device_id)) throw new Error('Unknown device');
    const state = await loadRegistry(directory, trust.instance_id);
    const device = approved(state, request.device_id); if (!device) throw new Error('Device not approved');
    prune();
    if (challenges.size >= 128 || [...challenges.values()].filter(item => item.device_id === device.device_id).length >= 5) throw new Error('Challenge limit');
    const item = { instance_id: trust.instance_id, device_id: device.device_id, generation: device.generation,
      challenge_id: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), expires_at: now() + 120000 };
    challenges.set(item.challenge_id, item); return item;
  }
  async function session(request) {
    exactObject(request, ['instance_id', 'device_id', 'challenge_id', 'signature']);
    prune();
    const item = challenges.get(request.challenge_id);
    if (!item) throw new Error('Challenge expired or consumed');
    challenges.delete(request.challenge_id); // Consume before any async work; even a wrong signature uses it.
    if (request.instance_id !== trust.instance_id || item.device_id !== request.device_id) throw new Error('Wrong challenge binding');
    const state = await loadRegistry(directory, trust.instance_id);
    const device = approved(state, request.device_id, item.generation);
    if (!device || !validSignature(challengeBytes(item), request.signature, publicDeviceKey(device.public_key))) throw new Error('Invalid device proof');
    if (sessions.size >= 256 || [...sessions.values()].filter(value => value.device_id === device.device_id).length >= 16) throw new Error('Session limit');
    const token = randomBytes(32).toString('base64url'), expires_at = now() + sessionMs;
    sessions.set(digest(token), { device_id: device.device_id, generation: device.generation, expires_at });
    return { session_token: token, expires_at };
  }
  async function authorize(req, res) {
    prune();
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : '';
    const session = token && sessions.get(digest(token));
    if (!session || stopped) return false;
    // Bound registry reads as well as streams; enforce before asynchronous I/O.
    const pending = [...pendingAuth.values()].reduce((sum, value) => sum + value, 0);
    const devicePending = pendingAuth.get(session.device_id) || 0;
    if (active.size + pending >= 32 || [...active.values()].filter(value => value.device_id === session.device_id).length + devicePending >= 8) return false;
    pendingAuth.set(session.device_id, devicePending + 1);
    try {
      const registry = await loadRegistry(directory, trust.instance_id);
      if (stopped || session.expires_at <= now() || !approved(registry, session.device_id, session.generation)) return false;
      if (res.destroyed || req.aborted) return false;
      active.set(res, session);
      const remove = () => active.delete(res);
      res.once('finish', remove); res.once('close', remove);
      return true;
    } finally {
      const remaining = pendingAuth.get(session.device_id) - 1;
      if (remaining) pendingAuth.set(session.device_id, remaining); else pendingAuth.delete(session.device_id);
    }
  }
  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      const state = await loadRegistry(directory, trust.instance_id);
      registryFailed = false;
      for (const [res, item] of active) if (!approved(state, item.device_id, item.generation)) { res.destroy(); active.delete(res); }
      for (const [key, item] of sessions) if (!approved(state, item.device_id, item.generation)) sessions.delete(key);
    } catch {
      for (const res of active.keys()) res.destroy(); active.clear(); sessions.clear(); challenges.clear();
      if (!registryFailed) logger({ event: 'device_auth', state: 'registry_unavailable' });
      registryFailed = true;
    } finally { polling = false; }
  }
  const timer = setInterval(() => { void poll(); }, 500); timer.unref();
  function handleControl(req, res) {
    if (!req.url?.startsWith('/bridge/v2')) return false;
    if (req.method !== 'POST' || !['/bridge/v2/enroll', '/bridge/v2/challenge', '/bridge/v2/session'].includes(req.url)) {
      req.resume(); json(res, 404, { error: { code: 'device_control_route_not_allowed' } }); return true;
    }
    if (now() - windowStart >= 60000) { windowStart = now(); controlCount = 0; }
    if (stopped || ++controlCount > 120 || controlActive >= 8) {
      req.resume(); json(res, 429, { error: { code: 'device_control_limit' } }); return true;
    }
    controlActive++;
    (async () => {
      const body = await readBody(req);
      const result = req.url === '/bridge/v2/enroll' ? await registerDevice(directory, trust.instance_id, body, now())
        : req.url === '/bridge/v2/challenge' ? await challenge(body) : await session(body);
      json(res, 200, result);
    })().catch(() => { req.resume(); json(res, 403, { error: { code: 'device_control_denied' } }); })
      .finally(() => { controlActive--; });
    return true;
  }
  return { handleControl, authorize, challenge, session, poll,
    close() { stopped = true; clearInterval(timer); for (const res of active.keys()) res.destroy(); active.clear(); challenges.clear(); sessions.clear(); } };
}
