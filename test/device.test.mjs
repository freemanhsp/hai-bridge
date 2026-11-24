import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { initializeDevicePublisher, initializeDeviceClient, normalizeDeviceConfig } from '../src/device-config.mjs';
import { loadApplicationConfig, loadToolClient } from '../src/app-config.mjs';
import { issueInvitation, loadRegistry, changeDeviceState, registerDevice, enrollmentRequest } from '../src/device-registry.mjs';
import { deviceTlsOptions, spkiPin, validateTrust, renewServerIdentity, loadServerIdentity } from '../src/device-identity.mjs';
import { challengeBytes, remainingDeviceLifetime, validateChallenge } from '../src/device-auth.mjs';
import { createPrivate, replacePrivate, readPrivateJson, withDeviceLock } from '../src/device-store.mjs';
import { startDevicePublisher, startDeviceClient, deviceControlRequest } from '../src/device-transport.mjs';
import { applicationSshArguments } from '../src/app-runtime.mjs';
import { applicationTlsReady } from '../src/app-readiness.mjs';
import { setupPublisher, defaultPublisherFile, setupClient, rememberClient, resolveDefaultClientFile } from '../src/profiles.mjs';
import { checkApplicationClient } from '../src/app-checks.mjs';
import { checkDeviceClient } from '../src/device-checks.mjs';
import { enrollDevice } from '../src/device-enrollment.mjs';
import { startSession } from '../src/session.mjs';
import { rawRequest, listen } from './helpers.mjs';
import { closeServer as close } from '../src/app-transport.mjs';

const execute = promisify(execFile);
const cli = path.resolve('bin/hai-bridge.mjs');
async function fixture(t, { hai = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-device-tests-'));
  const services = [];
  t.after(async () => { for (const service of services.reverse()) await service.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  const sshKey = path.join(temporary, 'ssh.key'), hosts = path.join(temporary, 'known_hosts');
  await createPrivate(sshKey, 'synthetic SSH only'); await createPrivate(hosts, 'synthetic host trust only');
  const options = { sshTarget: 'fixture@relay.invalid', identityFile: sshKey, knownHostsFile: hosts };
  const publisher = await initializeDevicePublisher(temporary, { ...options, mock: !hai, hai,
    ...(hai ? { model: 'test-model', upstreamUrl: 'http://127.0.0.1:6655', upstreamAuthFile: path.join(temporary, 'missing-hai-auth.json') } : {}) });
  const a = await loadApplicationConfig(publisher.serverFile, 'publisher');
  const invitation = path.join(temporary, 'invitation.json'); await issueInvitation(a.deviceDirectory, invitation);
  const initialized = await initializeDeviceClient(path.join(temporary, 'b.json'), { ...options, invitationFile: invitation, label: 'B 中文', ...(hai ? { model: 'test-model' } : {}) });
  const b = await loadApplicationConfig(initialized.clientFile, 'client');
  const state = () => loadRegistry(a.deviceDirectory, a.pair.trust.instance_id);
  const approve = () => changeDeviceState(a.deviceDirectory, a.pair.trust.instance_id, b.pair.identity.device_id, 'approved');
  const revoke = () => changeDeviceState(a.deviceDirectory, a.pair.trust.instance_id, b.pair.identity.device_id, 'revoked');
  const startA = async opts => { const service = await startDevicePublisher(a.pair, { config: a, port: 0, ...opts }); services.push(service); return service; };
  const startB = async (aService, opts) => { const service = await startDeviceClient(b.pair, { config: b, tlsPort: aService.port, port: 0, token: b.token, ...opts }); services.push(service); return service; };
  return { temporary, a, b, publisher, initialized, invitation, options, services, state, approve, revoke, startA, startB };
}
async function sessionFor(aService, b, override = {}) {
  const trust = b.pair.trust, identity = b.pair.identity;
  const challenge = await deviceControlRequest(trust, aService.port, '/bridge/v2/challenge', { instance_id: trust.instance_id, device_id: identity.device_id });
  const request = { instance_id: trust.instance_id, device_id: identity.device_id, challenge_id: challenge.challenge_id,
    signature: sign(null, challengeBytes(challenge), identity.key).toString('base64url'), ...override };
  const result = await deviceControlRequest(trust, aService.port, '/bridge/v2/session', request);
  return { challenge, request, result };
}
function tlsRequest(trust, port, route, token, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...deviceTlsOptions(trust), hostname: '127.0.0.1', port, path: route, method,
      headers: token ? { authorization: 'Bearer ' + token } : {} }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    }); req.once('error', reject); req.end(body);
  });
}
const local = (service, b, route = '/openai/v1/models', options = {}) => rawRequest(service.origin + route, {
  headers: { authorization: 'Bearer ' + b.token }, ...options });
async function runtimeProfile(f) {
  const raw = await readPrivateJson(f.initialized.clientFile);
  const port = async () => { const s = net.createServer(); const value = Number(new URL(await listen(s)).port); await close(s); return value; };
  raw.local_port = await port(); raw.tunnel_port = await port(); raw.reconnect = false;
  await replacePrivate(f.initialized.clientFile, JSON.stringify(raw));
  return loadApplicationConfig(f.initialized.clientFile, 'client');
}
function tcpHarness(targetPort) {
  const children = [];
  return { children, spawnProcess(_command, args, options) {
    assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child);
    const port = Number(args[args.indexOf('-L') + 1].split(':')[1]), sockets = new Set();
    const server = net.createServer(incoming => {
      const outgoing = net.connect(targetPort, '127.0.0.1');
      for (const s of [incoming, outgoing]) { sockets.add(s); s.on('error', () => { incoming.destroy(); outgoing.destroy(); });
        s.once('close', () => { sockets.delete(s); incoming.destroy(); outgoing.destroy(); }); }
      incoming.pipe(outgoing).pipe(incoming);
    });
    let stopped = false;
    child.kill = () => { if (stopped) return true; stopped = true; for (const s of sockets) s.destroy(); server.close(() => child.emit('close', 0)); return true; };
    server.on('error', () => child.emit('close', 255)); server.listen(port, '127.0.0.1'); return child;
  } };
}

test('v2 B generates only one local device key; invitation and A never receive it', async t => {
  const f = await fixture(t);
  const names = (await fs.readdir(f.b.deviceDirectory)).sort();
  assert.deepEqual(names, ['device.key', 'identity.json', 'invitation.json', 'trust.json']);
  const key = await fs.readFile(path.join(f.b.deviceDirectory, 'device.key'), 'utf8');
  assert.equal((await fs.readFile(f.invitation, 'utf8')).includes('PRIVATE KEY'), false);
  assert.equal((await fs.readFile(path.join(f.a.deviceDirectory, 'registry.json'), 'utf8')).includes(key), false);
  assert.equal(f.b.token, f.b.pair.identity.local_token);
  assert.equal((await loadToolClient(f.initialized.clientFile)).transport, 'app-device');
  assert.equal(deviceTlsOptions(f.b.pair.trust).cert, undefined);
  assert.ok(applicationSshArguments(f.a).includes('-R'));
  assert.ok(applicationSshArguments(f.b).includes('-L'));
  assert.throws(() => applicationSshArguments({ ...f.b, transport: 'plaintext' }));
});

test('one-time enrollment is pending, approval is local, replay cannot replace an identity', async t => {
  const f = await fixture(t), a = await f.startA(), b = await f.startB(a);
  const invite = await readPrivateJson(f.invitation), request = enrollmentRequest(invite, f.b.pair.identity, 'test B');
  assert.equal((await local(b, f.b)).status, 503);
  assert.equal(a.stats.requests, 0);
  assert.equal((await b.enroll()).state, 'pending');
  await assert.rejects(fs.stat(path.join(f.b.deviceDirectory, 'invitation.json')), { code: 'ENOENT' });
  assert.equal((await local(b, f.b)).status, 503);
  assert.equal((await registerDevice(f.a.deviceDirectory, invite.trust.instance_id, request)).state, 'pending');
  const other = generateKeyPairSync('ed25519');
  const forged = enrollmentRequest(invite, { key: other.privateKey, public_key: other.publicKey.export({ type: 'spki', format: 'pem' }), device_id: spkiPin(other.publicKey) }, 'attacker');
  await assert.rejects(registerDevice(f.a.deviceDirectory, invite.trust.instance_id, forged));
  await assert.rejects(registerDevice(f.a.deviceDirectory, invite.trust.instance_id, { ...request, label: 'changed' }));
  await f.approve();
  assert.equal((await local(b, f.b)).status, 200);
  assert.equal((await f.state()).devices[0].state, 'approved');
  assert.equal((await local(b, f.b, '/bridge/v2/challenge', { method: 'POST' })).status, 404);
  assert.equal((await tlsRequest(f.b.pair.trust, a.port, '/bridge/v2/approve', undefined, { method: 'POST' })).status, 404);
  await assert.rejects(f.approve(), /pending/);
});

test('expired invitation, wrong instance, bad proof and missing session never hit HAI', async t => {
  const f = await fixture(t), a = await f.startA(), b = await f.startB(a);
  const invite = await readPrivateJson(f.invitation), request = enrollmentRequest(invite, f.b.pair.identity, 'B');
  await assert.rejects(registerDevice(f.a.deviceDirectory, f.a.pair.trust.instance_id, request, invite.expires_at + 1));
  await assert.rejects(registerDevice(f.a.deviceDirectory, f.a.pair.trust.instance_id, { ...request, instance_id: '0'.repeat(64) }));
  await b.enroll(); await f.approve();
  for (const token of [undefined, 'wrong', f.b.token]) assert.equal((await tlsRequest(f.b.pair.trust, a.port, '/openai/v1/models', token)).status, 401);
  await assert.rejects(sessionFor(a, f.b, { signature: 'A'.repeat(86) }));
  await assert.rejects(sessionFor(a, f.b, { instance_id: '0'.repeat(64) }));
  const session = await sessionFor(a, f.b);
  await assert.rejects(deviceControlRequest(f.b.pair.trust, a.port, '/bridge/v2/session', session.request));
  assert.equal(a.stats.requests, 0);
});

test('server TLS refuses wrong CA, SPKI, name, root expiry, and plaintext', async t => {
  const f = await fixture(t), a = await f.startA();
  const other = await fixture(t), trust = f.b.pair.trust;
  assert.equal(await applicationTlsReady(f.b.pair, a.port), true);
  for (const invalid of [{ ...trust, ca: other.b.pair.trust.ca }, { ...trust, server_spki_pin: '0'.repeat(64) },
    { ...trust, server_name: 'wrong.invalid' }]) await assert.rejects(tlsRequest(invalid, a.port, '/healthz'));
  assert.throws(() => validateTrust(trust, Date.parse(new X509Certificate(trust.ca).validTo) + 1), /expired/);
  const plain = await rawRequest('http://127.0.0.1:' + a.port + '/healthz').catch(() => ({ status: 0 }));
  assert.notEqual(plain.status, 200); assert.equal(a.stats.requests, 0);
});

test('B wall clocks ahead or behind A do not reject fresh challenges or sessions', async t => {
  const f = await fixture(t), a = await f.startA(), enrollment = await f.startB(a);
  await enrollment.enroll(); await enrollment.close(); await f.approve();
  for (const offset of [-7200000, -1853, 1853, 7200000]) {
    const b = await f.startB(a, { now: () => Date.now() + offset });
    const reply = await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' });
    assert.equal(reply.status, 200, 'B wall-clock offset: ' + offset);
    await b.close();
  }
  assert.equal(a.stats.requests, 4, 'Exactly one model request per user action');
});

test('B clock jumps or sleep invalidate cached sessions before the next new POST', async t => {
  const f = await fixture(t), a = await f.startA();
  let wall = Date.now(), mono = 0, sessions = 0;
  const b = await f.startB(a, { now: () => wall, monotonic: () => mono,
    async request(...args) { const result = await deviceControlRequest(...args); if (args[2].endsWith('/session')) sessions++; return result; } });
  await b.enroll(); await f.approve();
  for (const change of [0, 7200000, -14400000, 7200000]) {
    wall += change;
    assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  }
  assert.equal(sessions, 4); assert.equal(a.stats.requests, 4);
  // Simulate suspension where the monotonic clock did not advance with wall time.
  wall += 700000;
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  assert.equal(sessions, 5); assert.equal(a.stats.requests, 5);
});

test('B fails closed on missing, malformed or inconsistent authenticated server time', async t => {
  for (const route of ['/bridge/v2/challenge', '/bridge/v2/session']) for (const variant of ['missing', 'malformed', 'past', 'future']) {
    const f = await fixture(t), a = await f.startA(), b = await f.startB(a);
    await b.enroll(); await f.approve();
    a.server.prependListener('request', (req, res) => {
      if (req.url !== route) return;
      if (variant === 'missing') res.sendDate = false;
      else res.setHeader('date', variant === 'malformed' ? 'invalid-date'
        : new Date(Date.now() + (variant === 'past' ? -3600000 : 3600000)).toUTCString());
    });
    assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 503, route + '/' + variant);
    assert.equal(a.stats.requests, 0);
    await b.close(); await a.close();
  }
});

test('server-time budgets subtract Date rounding and round trips without accepting excessive or expired lifetimes', () => {
  const serverTime = 1700000000000, timing = { serverTime, elapsedMs: 17.5 };
  assert.equal(remainingDeviceLifetime(serverTime + 120500, timing, 120000), 119482.5);
  assert.equal(remainingDeviceLifetime(serverTime + 600500, timing, 600000), 599482.5);
  assert.equal(remainingDeviceLifetime(serverTime + 500, timing, 600000), 0, 'No safe cache budget for a sub-second lifetime');
  for (const expiresAt of [serverTime, serverTime + 17, serverTime + 121001, NaN, 'invalid'])
    assert.throws(() => remainingDeviceLifetime(expiresAt, timing, 120000));
  for (const invalid of [undefined, {}, { serverTime, elapsedMs: -1 }, { serverTime, elapsedMs: Infinity },
    { serverTime: NaN, elapsedMs: 0 }]) assert.throws(() => remainingDeviceLifetime(serverTime + 120000, invalid, 120000));
  const challenge = { instance_id: 'a'.repeat(64), device_id: 'b'.repeat(64), generation: 1,
    challenge_id: 'c'.repeat(43), nonce: 'd'.repeat(43), expires_at: serverTime + 120500 };
  assert.equal(validateChallenge(challenge, challenge.instance_id, challenge.device_id, timing), challenge);
  assert.throws(() => validateChallenge(challenge, 'e'.repeat(64), challenge.device_id, timing));
  assert.throws(() => validateChallenge({ ...challenge, generation: 0 }, challenge.instance_id, challenge.device_id, timing));
  assert.throws(() => validateChallenge({ ...challenge, expires_at: serverTime + 500 }, challenge.instance_id, challenge.device_id, timing));
});

test('bad session lifetimes are rejected before a POST; a short safe session is never overcached', async t => {
  const f = await fixture(t), a = await f.startA();
  let variant = 'expired', sessions = 0;
  const b = await f.startB(a, { async request(trust, port, route, body, options) {
    let serverTime;
    const value = await deviceControlRequest(trust, port, route, body, { ...options,
      onServerTime(time) { serverTime = time; options.onServerTime?.(time); } });
    if (route.endsWith('/session')) {
      sessions++;
      value.expires_at = serverTime + (variant === 'expired' ? -1 : variant === 'excessive' ? 601001 : 500);
    }
    return value;
  } });
  await b.enroll(); await f.approve();
  for (const item of ['expired', 'excessive']) {
    variant = item;
    assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 503);
    assert.equal(a.stats.requests, 0);
  }
  variant = 'short';
  for (let i = 0; i < 2; i++) assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  assert.equal(sessions, 4); assert.equal(a.stats.requests, 2);
});

test('a delayed control response cannot extend the challenge lifetime or send a model POST', async t => {
  const f = await fixture(t), a = await f.startA();
  let mono = 0;
  const b = await f.startB(a, { monotonic: () => mono, async request(...args) {
    const value = await deviceControlRequest(...args);
    if (args[2].endsWith('/challenge')) mono += 120001;
    return value;
  } });
  await b.enroll(); await f.approve();
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 503);
  assert.equal(a.stats.requests, 0);
});

test('session expiry refreshes before new POST; expired session and A restart fail without POST replay', async t => {
  const f = await fixture(t); let clock = Date.now(); const now = () => clock;
  const a = await f.startA({ authOptions: { now, sessionMs: 1000 } }), b = await f.startB(a, { now, monotonic: now });
  // The authority uses a synthetic clock; serve its own time just like the real A.
  a.server.prependListener('request', (_req, res) => res.setHeader('date', new Date(now()).toUTCString()));
  await b.enroll(); await f.approve();
  const first = await sessionFor(a, f.b);
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  clock += 1100;
  assert.equal((await tlsRequest(f.b.pair.trust, a.port, '/openai/v1/models', first.result.session_token)).status, 401);
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  assert.equal(a.stats.requests, 2);
  // Clear A's sessions just like a restart, while B still has a cached token.
  a.authority.close();
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 401);
  assert.equal(a.stats.requests, 2);
});

test('approved device streams Unicode/concurrent SSE, cancels upstream and preserves errors without replay', async t => {
  const f = await fixture(t), a = await f.startA({ intervalMs: 20 }), b = await f.startB(a, { idleTimeoutMs: 1000 });
  await b.enroll(); await f.approve();
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).body.toString().includes('中文'), true);
  const streams = await Promise.all(Array.from({ length: 4 }, () => local(b, f.b, '/openai/v1/responses?case=stream', { method: 'POST' })));
  for (const stream of streams) { assert.equal(stream.status, 200); assert.match(stream.body.toString(), /response.completed/); assert.match(stream.body.toString(), /中文/); }
  for (const status of [429, 503]) {
    const before = a.stats.requests;
    const response = await local(b, f.b, '/openai/v1/responses?case=' + status, { method: 'POST' });
    assert.equal(response.status, status); assert.equal(response.headers['retry-after'], '7'); assert.equal(a.stats.requests, before + 1);
  }
  await new Promise((resolve, reject) => {
    const req = http.request(b.origin + '/openai/v1/responses?case=cancel', { method: 'POST', headers: { authorization: 'Bearer ' + f.b.token } }, res => {
      res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {});
    }); req.on('error', reject); req.end();
  });
  await pause(80); assert.equal(a.stats.activeStreams, 0); assert.ok(a.stats.cancelledStreams >= 1);
  assert.equal((await local(b, f.b, '/openai/v1/models', { headers: {} })).status, 401);
  assert.equal((await local(b, f.b, '/openai/v1/models', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('A revoke denies old sessions and cancels active streams; revoked identities cannot be restored', async t => {
  const f = await fixture(t), a = await f.startA({ intervalMs: 20 }), b = await f.startB(a);
  await b.enroll(); await f.approve(); const session = await sessionFor(a, f.b);
  let response;
  const cancelled = new Promise(resolve => {
    const req = http.request(b.origin + '/openai/v1/responses?case=cancel', { method: 'POST', headers: { authorization: 'Bearer ' + f.b.token } }, res => {
      response = res; res.resume(); res.once('close', resolve); res.on('error', () => {});
    }); req.on('error', resolve); req.end();
  });
  for (let i = 0; i < 100 && !response; i++) await pause(10);
  assert.ok(response); assert.equal(a.stats.activeStreams, 1);
  const saved = await f.revoke(); assert.equal(saved.running_service, 'not_confirmed');
  assert.equal((await tlsRequest(f.b.pair.trust, a.port, '/openai/v1/models', session.result.session_token)).status, 401);
  await Promise.race([cancelled, pause(2000).then(() => { throw new Error('Revocation cancellation timed out'); })]);
  await pause(30); assert.equal(a.stats.activeStreams, 0);
  await assert.rejects(f.approve(), /pending/);
  await assert.rejects(sessionFor(a, f.b));
});

test('A renewal keeps CA/server key/SPKI; running client survives certificate replacement', async t => {
  const f = await fixture(t), a = await f.startA(), b = await f.startB(a);
  await b.enroll(); await f.approve();
  const before = await loadServerIdentity(f.a.deviceDirectory);
  const renewed = await renewServerIdentity(f.a.deviceDirectory, { force: true });
  assert.equal(renewed.renewed, true); assert.equal(renewed.trust.server_spki_pin, before.trust.server_spki_pin);
  assert.equal(renewed.cert.equals(before.cert), false); assert.equal(renewed.key.equals(before.key), true); assert.equal(renewed.ca.equals(before.ca), true);
  assert.equal((await renewServerIdentity(f.a.deviceDirectory)).renewed, false);
  await a.refreshCertificate({ force: true });
  assert.equal((await local(b, f.b)).status, 200);
});

test('A startup automatically renews near-expiry and expired leaves without changing B trust', async t => {
  const f = await fixture(t), directory = f.a.deviceDirectory;
  for (const days of [1, 0]) {
    const temporary = path.join(directory, 'synthetic-leaf.pem');
    if (days === 1) {
      await execute('openssl', ['x509', '-in', path.join(directory, 'server.pem'), '-CA', path.join(directory, 'ca.pem'),
        '-CAkey', path.join(directory, 'ca.key'), '-set_serial', '17', '-days', '1', '-out', temporary]);
    } else {
      // LibreSSL rejects x509 -days 0. Sign an actually expired fixture with
      // explicit past dates instead; do not skip the expired-leaf branch.
      const issuer = path.join(directory, 'synthetic-expired-issuer'); await fs.mkdir(issuer, { mode: 0o700 });
      const index = path.join(issuer, 'index'), serial = path.join(issuer, 'serial');
      const settings = path.join(issuer, 'ca.cnf'), csr = path.join(issuer, 'leaf.csr');
      await createPrivate(index, ''); await createPrivate(serial, '17\n');
      await createPrivate(settings, [
        '[ca]', 'default_ca = issuer', '[issuer]',
        'database = ' + index, 'serial = ' + serial, 'new_certs_dir = ' + issuer,
        'default_md = sha256', 'policy = identity', 'x509_extensions = server',
        '[identity]', 'commonName = supplied', '[server]',
        'basicConstraints = critical,CA:FALSE', 'extendedKeyUsage = serverAuth',
        'subjectAltName = DNS:' + f.b.pair.trust.server_name, '',
      ].join('\n'));
      await execute('openssl', ['req', '-new', '-key', path.join(directory, 'server.key'),
        '-subj', '/CN=' + f.b.pair.trust.server_name, '-out', csr]);
      await execute('openssl', ['ca', '-batch', '-notext', '-config', settings, '-cert', path.join(directory, 'ca.pem'),
        '-keyfile', path.join(directory, 'ca.key'), '-in', csr, '-out', temporary,
        '-startdate', '20200101000000Z', '-enddate', '20200102000000Z']);
    }
    await fs.chmod(temporary, 0o600);
    await replacePrivate(path.join(directory, 'server.pem'), await fs.readFile(temporary)); await fs.unlink(temporary);
    const before = await loadServerIdentity(directory, { allowExpiredLeaf: true });
    assert.ok(before.expires - Date.now() < 2 * 86400000);
    assert.equal(before.expires <= Date.now(), days === 0);
    const config = await loadApplicationConfig(f.publisher.serverFile, 'publisher');
    const service = await startDevicePublisher(config.pair, { config }); f.services.push(service);
    const after = await loadServerIdentity(directory);
    assert.ok(after.expires - Date.now() > 6 * 86400000);
    assert.equal(after.trust.server_spki_pin, f.b.pair.trust.server_spki_pin);
    assert.equal(await applicationTlsReady(f.b.pair, service.port), true); await service.close();
  }
});

test('v2 private storage refuses symbolic links, permissive Unix state and mismatched signing keys', async t => {
  const f = await fixture(t), original = path.join(f.a.deviceDirectory, 'registry.json'), source = path.join(f.a.deviceDirectory, 'registry.original');
  await fs.rename(original, source); await fs.symlink(source, original);
  await assert.rejects(f.state()); await fs.unlink(original); await fs.rename(source, original);
  if (process.platform !== 'win32') {
    await fs.chmod(original, 0o644); await assert.rejects(f.state()); await fs.chmod(original, 0o600);
  }
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await replacePrivate(path.join(f.a.deviceDirectory, 'ca.key'), other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await assert.rejects(renewServerIdentity(f.a.deviceDirectory), /mismatch/);
  await assert.rejects(loadApplicationConfig(f.publisher.serverFile, 'publisher'), /mismatch/);
});

test('corrupt registry and live writer lock fail closed without repairing, replacing or leaking state', async t => {
  const f = await fixture(t), a = await f.startA(), b = await f.startB(a);
  await b.enroll(); await f.approve(); assert.equal((await local(b, f.b)).status, 200);
  await withDeviceLock(f.a.deviceDirectory, async () => {
    await assert.rejects(f.revoke(), /locked/);
    assert.equal((await local(b, f.b)).status, 200); // Readers may use a valid atomic snapshot.
  });
  await replacePrivate(path.join(f.a.deviceDirectory, 'registry.json'), 'not JSON');
  const count = a.stats.requests;
  assert.equal((await local(b, f.b)).status, 503); assert.equal(a.stats.requests, count);
  await a.authority.poll(); await assert.rejects(f.state());
});

test('bounded challenge and control bodies reject excess; no data path has an authentication fallback', async t => {
  const f = await fixture(t), a = await f.startA(), b = await f.startB(a);
  await b.enroll(); await f.approve();
  for (let i = 0; i < 5; i++) await a.authority.challenge({ instance_id: f.b.pair.trust.instance_id, device_id: f.b.pair.identity.device_id });
  await assert.rejects(a.authority.challenge({ instance_id: f.b.pair.trust.instance_id, device_id: f.b.pair.identity.device_id }), /limit/);
  await assert.rejects(deviceControlRequest(f.b.pair.trust, a.port, '/bridge/v2/enroll', { junk: 'x'.repeat(20000) }));
  assert.equal((await local(b, f.b)).status, 503); assert.equal(a.stats.requests, 0);
});

test('v2 configuration and local defaults stay isolated; v1 checks refuse mislabeled v2 evidence', async t => {
  const f = await fixture(t);
  const raw = await readPrivateJson(f.initialized.clientFile);
  assert.throws(() => normalizeDeviceConfig({ ...raw, bridge_token: 'wrong' }, f.initialized.clientFile, 'client'));
  assert.throws(() => normalizeDeviceConfig({ ...raw, schema_version: 1 }, f.initialized.clientFile, 'client'));
  assert.throws(() => normalizeDeviceConfig({ ...raw, ssh_target: 'root@relay.invalid' }, f.initialized.clientFile, 'client'));
  await setupPublisher(f.publisher.serverFile, path.join(f.temporary, 'a-profile'));
  assert.equal(await defaultPublisherFile(path.join(f.temporary, 'a-profile')), f.publisher.serverFile);
  await assert.rejects(checkApplicationClient({ clientFile: f.initialized.clientFile, out: path.join(f.temporary, 'report.json') }), /v1/);
  await assert.rejects(fs.stat(path.join(f.temporary, 'report.json')), { code: 'ENOENT' });
  const result = await execute(process.execPath, [cli, 'devices', '--server-config', f.publisher.serverFile, '--json']);
  assert.deepEqual(JSON.parse(result.stdout), { devices: [] });
  await assert.rejects(execute(process.execPath, [cli, 'approve-device', '--server-config', f.publisher.serverFile, '--device-id', 'short']));
  await assert.rejects(execute(process.execPath, [cli, 'init-device-client', '--mock']));
  await assert.rejects(execute(process.execPath, [cli, 'connect', '--client-config', f.initialized.clientFile]));
  await assert.rejects(execute(process.execPath, [cli, 'doctor', '--client-config', f.initialized.clientFile, '--base-url', 'http://127.0.0.1:1']));
});

test('HAI auth is lazy: pairing/approval/health work without reading a missing HAI key; model path fails safely', async t => {
  const f = await fixture(t, { hai: true }), a = await f.startA(), b = await f.startB(a);
  await b.enroll(); await f.approve();
  assert.equal((await local(b, f.b, '/healthz')).status, 200);
  assert.equal((await local(b, f.b)).status, 503);
  await setupClient(f.initialized.clientFile, path.join(f.temporary, 'b-profile'));
  const profile = await loadApplicationConfig(path.join(f.temporary, 'b-profile/client.json'), 'client');
  assert.equal(profile.deviceDirectory, f.b.deviceDirectory);
  assert.deepEqual(await fs.readdir(path.join(f.temporary, 'b-profile')), ['client.json']);
  assert.equal(profile.token, f.b.token);
});

test('use-client reuses approved v2 device identity and registry with no key copy or enrollment', async t => {
  const f = await fixture(t, { hai: true }), a = await f.startA(), b = await f.startB(a);
  await b.enroll(); await f.approve();
  const original = await fs.readFile(f.initialized.clientFile), registry = await loadRegistry(f.a.deviceDirectory, f.a.pair.trust.instance_id);
  const root = path.join(f.temporary, 'remember-real');
  await rememberClient(f.initialized.clientFile, root);
  const config = await loadApplicationConfig(await resolveDefaultClientFile(root), 'client');
  assert.equal(config.deviceDirectory, f.b.deviceDirectory);
  assert.equal(config.pair.identity.device_id, f.b.pair.identity.device_id);
  assert.equal(config.token, f.b.token);
  assert.deepEqual(await fs.readdir(root), ['client-default.json']);
  assert.deepEqual(await fs.readFile(f.initialized.clientFile), original);
  assert.deepEqual(await loadRegistry(f.a.deviceDirectory, f.a.pair.trust.instance_id), registry);
});

test('v2 enrollment owns one synthetic SSH child, releases ports and preserves foreign listeners', async t => {
  const f = await fixture(t), a = await f.startA(), config = await runtimeProfile(f);
  const harness = tcpHarness(a.port), signals = new EventEmitter(), events = [];
  const result = await enrollDevice(f.initialized.clientFile, { signals, runtimeOptions: harness, onEvent: event => events.push(event) });
  assert.equal(result.state, 'pending'); assert.equal(harness.children.length, 1);
  assert.equal(events.every(event => event.transport === 'app-device'), true);
  const localListener = net.createServer(); await new Promise(resolve => localListener.listen(config.localPort, '127.0.0.1', resolve));
  const tunnelListener = net.createServer(); await new Promise(resolve => tunnelListener.listen(config.tunnelPort, '127.0.0.1', resolve));
  await close(localListener); await close(tunnelListener);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
  const occupied = net.createServer(); await new Promise(resolve => occupied.listen(config.tunnelPort, '127.0.0.1', resolve));
  t.after(() => close(occupied));
  await assert.rejects(enrollDevice(f.initialized.clientFile, { runtimeOptions: harness }));
  assert.equal(occupied.listening, true); assert.equal(harness.children.length, 1);
});

test('B one-shot v2 batch is mock-only, complete and produces no key/token/output in its report', async t => {
  const f = await fixture(t), a = await f.startA({ intervalMs: 20 }), config = await runtimeProfile(f);
  const b = await f.startB(a); await b.enroll(); await b.close(); await f.approve();
  const harness = tcpHarness(a.port), signals = new EventEmitter(), out = path.join(f.temporary, 'device-report.json');
  const result = await checkDeviceClient({ clientFile: f.initialized.clientFile, out }, { signals, runtimeOptions: harness, evidence: 'synthetic-TCP-local-only' });
  assert.equal(result.report.status, 'pass', JSON.stringify(result.report)); assert.equal(result.report.checks.length, 15);
  assert.equal(result.report.session_time_basis, 'authenticated_server_http_date');
  assert.equal(result.report.checks.every(item => item.status === 'pass'), true); assert.equal(harness.children.length, 1);
  const reportText = await fs.readFile(out, 'utf8');
  for (const value of [config.token, config.pair.identity.public_key, 'PRIVATE KEY', 'relay-ok 中文']) assert.equal(reportText.includes(value), false);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  await assert.rejects(checkDeviceClient({ clientFile: f.initialized.clientFile, out }, { runtimeOptions: harness }), { code: 'EEXIST' });
  assert.equal(harness.children.length, 1);
  const real = await fixture(t, { hai: true });
  await assert.rejects(checkDeviceClient({ clientFile: real.initialized.clientFile, out: path.join(real.temporary, 'report.json') }), /MOCK/);
});

test('failed device acceptance reports the HTTP authentication boundary without exposing raw errors or credentials', async t => {
  const f = await fixture(t), a = await f.startA(); await runtimeProfile(f);
  const b = await f.startB(a); await b.enroll(); await b.close(); // Leave pending.
  const out = path.join(f.temporary, 'failed-device-report.json');
  const result = await checkDeviceClient({ clientFile: f.initialized.clientFile, out }, { runtimeOptions: tcpHarness(a.port) });
  assert.equal(result.report.status, 'fail');
  assert.deepEqual(result.report.checks[0], { check: 'server-tls-device-session-and-mock-identity', status: 'fail',
    http_status: 503, reason: 'application_authentication_unavailable' });
  assert.equal(result.report.checks.slice(1).every(item => item.status === 'pass'), true);
  const contents = await fs.readFile(out, 'utf8');
  for (const secret of [f.b.token, f.b.pair.identity.public_key, 'PRIVATE KEY', 'challenge_id', 'session_token']) assert.equal(contents.includes(secret), false);
});

test('A physical restart transparently reauthenticates the next new request after one 401 without replay', async t => {
  const f = await fixture(t), first = await f.startA(); let currentPort = first.port;
  const relay = net.createServer(incoming => {
    const outgoing = net.connect(currentPort, '127.0.0.1');
    for (const socket of [incoming, outgoing]) { socket.on('error', () => { incoming.destroy(); outgoing.destroy(); }); socket.once('close', () => { incoming.destroy(); outgoing.destroy(); }); }
    incoming.pipe(outgoing).pipe(incoming);
  });
  const relayPort = Number(new URL(await listen(relay)).port); f.services.push({ close: () => close(relay) });
  const b = await f.startB({ port: relayPort }); await b.enroll(); await f.approve();
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  await first.close(); const second = await f.startA(); currentPort = second.port;
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 401);
  assert.equal(second.stats.requests, 0);
  assert.equal((await local(b, f.b, '/openai/v1/responses?case=json', { method: 'POST' })).status, 200);
  assert.equal(second.stats.requests, 1);
});

test('v2 session launcher is agent-decoupled and keeps network sessions out of agent environment', async t => {
  const f = await fixture(t, { hai: true });
  const key = 'synthetic-device-session-upstream-key', auth = f.a.authFile;
  await createPrivate(auth, JSON.stringify({ OPENAI_API_KEY: key }));
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + key); req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: f.b.model }] }));
  });
  f.a.upstream = new URL(await listen(upstream)); f.services.push({ close: () => close(upstream) });
  const a = await f.startA(), b = await f.startB(a); await b.enroll(); await b.close(); await f.approve();
  const config = await runtimeProfile(f), harness = tcpHarness(a.port), project = path.join(f.temporary, 'project'); await fs.mkdir(project);
  // config sits in temporary root, so use a distinct B-only private directory, not the project parent.
  const configRoot = path.join(f.temporary, 'private-profile'); await fs.mkdir(configRoot, { mode: 0o700 });
  const file = path.join(configRoot, 'client.json'), raw = await readPrivateJson(f.initialized.clientFile);
  await createPrivate(file, JSON.stringify({ ...raw, device_dir: config.deviceDirectory }));
  let invoked = 0;
  const code = await startSession({ clientFile: file, project }, { runtimeOptions: harness,
    async launchCodex(client, origin, _args, _env, options) {
      invoked++; assert.equal(client.token, config.token); assert.equal(options.cwd, await fs.realpath(project));
      assert.ok(origin.startsWith('http://127.0.0.1:')); return 0;
    } });
  assert.equal(code, 0); assert.equal(invoked, 1); assert.equal(harness.children.length, 1);
});
