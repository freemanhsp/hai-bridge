import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generatePair } from '../src/app-identity.mjs';
import { inspectApplication, formatApplicationInspection } from '../src/app-inspect.mjs';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../bin/hai-bridge.mjs', import.meta.url));
const POISON = 'SYNTHETIC-SECRET-DO-NOT-EXPORT';
let temporary, pairs, clock, serial = 0;
before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-inspect-'));
  pairs = { mock: await generatePair(path.join(temporary, 'mock'), { mode: 'mock' }),
    hai: await generatePair(path.join(temporary, 'hai'), { mode: 'hai' }) };
  const cert = new X509Certificate(await fs.readFile(path.join(pairs.hai, 'client.pem')));
  clock = Date.parse(cert.validFrom) + 3600000;
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

async function fixture(role = 'client', mode = 'hai') {
  const root = path.join(temporary, 'case-' + serial++); await fs.mkdir(root, { mode: 0o700 });
  const tls = path.join(root, 'tls'); await fs.mkdir(tls, { mode: 0o700 });
  for (const name of ['ca.pem', 'server.pem', 'client.pem', 'pair.json']) await fs.copyFile(path.join(pairs[mode], name), path.join(tls, name));
  for (const name of ['client.key', 'server.key', 'access.json']) await fs.writeFile(path.join(tls, name), POISON, { mode: 0o600 });
  for (const name of ['identity', 'auth.json', 'known_hosts']) await fs.writeFile(path.join(root, name), POISON, { mode: 0o600 });
  const raw = { schema_version: 1, transport: 'app-tls', role, mode, ssh_target: 'test@ecs.example', ssh_port: 2222,
    identity_file: 'identity', known_hosts_file: 'known_hosts', relay_port: 18083, reconnect: true, max_retries: 5,
    tls_dir: 'tls', ...(role === 'client' ? { local_port: 18084, tunnel_port: 18085 }
      : { app_port: 18081, ...(mode === 'hai' ? { upstream_url: 'http://127.0.0.1:6655', upstream_auth_file: 'auth.json' } : {}) }) };
  const file = path.join(root, role === 'client' ? 'client.json' : 'server.json');
  await fs.writeFile(file, JSON.stringify(raw), { mode: 0o600 });
  const reads = [], commands = [], ports = [];
  const allowed = new Set([file, ...['ca.pem', 'server.pem', 'client.pem', 'pair.json'].map(n => path.join(tls, n))]);
  const files = { ...fs, async open(filename, ...args) {
    assert.ok(allowed.has(filename), 'Offline inspection must not read private/HAI material: ' + path.basename(filename));
    reads.push(path.basename(filename)); return fs.open(filename, ...args);
  }, readFile: () => assert.fail('Only bounded safe open/read is allowed') };
  const dependencies = { files, now: () => clock, probe: async port => { ports.push(port); },
    run: async (name, args, options) => {
      commands.push([name, args]); assert.ok(options.timeout <= 5000); assert.equal(options.shell, undefined);
      if (name === 'ssh') { assert.deepEqual(args, ['-V']); return { stderr: 'OpenSSH_9.9 ' + POISON }; }
      assert.equal(name, 'ssh-keygen'); assert.deepEqual(args, ['-F', '[ecs.example]:2222', '-f', path.join(root, 'known_hosts')]);
      return { stdout: '# matched\n[ecs.example]:2222 ssh-ed25519 synthetic\n' + POISON };
    } };
  const inspect = extra => inspectApplication({ file, role }, { ...dependencies, ...extra });
  return { root, tls, raw, file, reads, commands, ports, allowed, dependencies, inspect };
}
function safe(report) {
  const text = JSON.stringify(report) + formatApplicationInspection(report);
  assert.equal(text.includes(POISON), false); assert.equal(text.includes('BEGIN'), false);
  assert.equal(text.includes('ecs.example'), false); assert.equal(text.includes('server_pin'), false);
}
function check(report, id) { return report.checks.find(c => c.id === id); }

test('offline inspection reads only public certs/config and metadata, never private or HAI contents', async () => {
  for (const role of ['publisher', 'client']) {
    const f = await fixture(role), report = await f.inspect();
    assert.equal(report.status, 'pass'); safe(report);
    assert.equal(check(report, 'tls.client.pin').status, 'pass');
    assert.equal(check(report, 'tls.client.issuer_purpose').status, 'pass');
    assert.deepEqual(f.ports, role === 'client' ? [18084, 18085] : [18081]);
    assert.equal(f.reads.some(n => n.endsWith('.key') || n === 'auth.json' || n === 'access.json'), false);
    assert.deepEqual(f.commands.map(c => c[0]), ['ssh', 'ssh-keygen']);
    assert.ok(report.not_checked.includes('private_key_match'));
    assert.equal(report.not_checked.includes('remote_server_certificate_pin_and_name'), role === 'client');
  }
});

test('validity distinguishes healthy, near expiry, expired and not-yet-valid without renewal', async () => {
  const f = await fixture(), cert = new X509Certificate(await fs.readFile(path.join(f.tls, 'client.pem')));
  const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
  for (const [instant, state, status] of [[from + 3600000, 'valid', 'pass'], [to - 3600000, 'near_expiry', 'warn'],
    [to + 1000, 'expired', 'fail'], [from - 1000, 'not_yet_valid', 'fail']]) {
    const report = await f.inspect({ now: () => instant }), c = check(report, 'tls.client.validity');
    assert.equal(c.certificate_state, state); assert.equal(c.status, status);
    assert.equal(c.valid_to, new Date(to).toISOString()); safe(report);
  }
});

test('tampered pairing, pin, issuer, name and malformed/extra-material certificates fail safely', async () => {
  for (const issue of ['pair', 'pin', 'issuer', 'name', 'malformed', 'extra']) {
    const f = await fixture('publisher');
    const pairFile = path.join(f.tls, 'pair.json'), pair = JSON.parse(await fs.readFile(pairFile));
    if (issue === 'pair') await fs.writeFile(pairFile, JSON.stringify({ ...pair, secret: POISON }));
    if (issue === 'pin') await fs.writeFile(pairFile, JSON.stringify({ ...pair, server_pin: '0'.repeat(64) }));
    if (issue === 'issuer') await fs.copyFile(path.join(pairs.mock, 'ca.pem'), path.join(f.tls, 'ca.pem'));
    if (issue === 'name') {
      const pem = await fs.readFile(path.join(pairs.mock, 'server.pem'));
      await fs.writeFile(path.join(f.tls, 'server.pem'), pem);
      await fs.writeFile(pairFile, JSON.stringify({ ...pair, server_pin: new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase() }));
    }
    if (issue === 'malformed') await fs.writeFile(path.join(f.tls, 'client.pem'), POISON);
    if (issue === 'extra') await fs.appendFile(path.join(f.tls, 'client.pem'), '\n' + POISON);
    const report = await f.inspect(); assert.equal(report.status, 'fail'); safe(report);
    if (issue === 'name') assert.equal(check(report, 'tls.server.name').status, 'fail');
  }
});

test('invalid schema, role, port, root SSH, forbidden upstream and secret poisoning are rejected before commands', async () => {
  const f = await fixture();
  for (const change of [{ role: 'publisher' }, { transport: 'ssh' }, { local_port: 22 }, { tunnel_port: 18084 },
    { ssh_target: 'root@ecs.example' }, { upstream_auth_file: POISON }, { tls_dir: 'bad\n' + POISON }, { bridge_token: POISON }]) {
    await fs.writeFile(f.file, JSON.stringify({ ...f.raw, ...change }));
    const report = await f.inspect(); assert.equal(report.status, 'fail'); safe(report);
  }
  assert.equal(f.commands.length, 0); assert.equal(f.ports.length, 0);
  await assert.rejects(inspectApplication({ file: f.file, role: POISON }), /requires/);
});

test('default pointer/client profile is checked safely and missing or poisoned defaults never start services', async () => {
  const f = await fixture('publisher'), profile = path.join(f.root, 'profile'); await fs.mkdir(profile, { mode: 0o700 });
  const pointer = path.join(profile, 'publisher-default.json'); f.allowed.add(pointer);
  const pointerData = { schema_version: 1, transport: 'app-tls', role: 'publisher-default', server_config: f.file };
  await fs.writeFile(pointer, JSON.stringify(pointerData), { mode: 0o600 });
  let report = await inspectApplication({ role: 'publisher', profileDir: profile }, f.dependencies);
  assert.equal(report.status, 'pass'); safe(report);
  for (const change of [{ server_config: 'relative.json' }, { secret: POISON }, { schema_version: 2 }]) {
    await fs.writeFile(pointer, JSON.stringify({ ...pointerData, ...change }));
    report = await inspectApplication({ role: 'publisher', profileDir: profile }, f.dependencies);
    assert.equal(check(report, 'default.pointer').status, 'fail'); safe(report);
  }
  await fs.unlink(pointer);
  report = await inspectApplication({ role: 'publisher', profileDir: profile }, f.dependencies);
  assert.equal(report.status, 'fail');
  const b = await fixture(); report = await inspectApplication({ role: 'client', profileDir: b.root }, b.dependencies);
  assert.equal(report.status, 'pass');
  report = await inspectApplication({ role: 'client', profileDir: path.join(f.root, 'absent') }, f.dependencies);
  assert.equal(report.status, 'fail'); safe(report);
});

test('client pointer inspection follows the selected config without reading keys or falling back after corruption', async () => {
  const f = await fixture(), pointer = path.join(f.root, 'client-default.json'); f.allowed.add(pointer);
  await fs.writeFile(pointer, JSON.stringify({ schema_version: 1, role: 'client-default', client_config: f.file }), { mode: 0o600 });
  let report = await inspectApplication({ role: 'client', profileDir: f.root }, f.dependencies);
  assert.equal(report.status, 'pass'); assert.equal(check(report, 'default.pointer').status, 'pass'); safe(report);
  f.reads.length = 0; await fs.writeFile(pointer, JSON.stringify({ schema_version: 1, role: 'client-default', client_config: 'relative.json', secret: POISON }));
  report = await inspectApplication({ role: 'client', profileDir: f.root }, f.dependencies);
  assert.equal(report.status, 'fail'); assert.deepEqual(f.reads, ['client-default.json']); safe(report);
});

test('symlinks, oversized public data and unsafe Unix permissions are rejected without reading contents', async () => {
  const f = await fixture();
  const beforeReads = f.reads.length;
  await fs.writeFile(f.file, 'x'.repeat(65537));
  assert.equal((await f.inspect()).status, 'fail'); assert.equal(f.reads.length, beforeReads);
  await fs.writeFile(f.file, JSON.stringify(f.raw));
  if (process.platform !== 'win32') {
    await fs.chmod(f.file, 0o644); assert.equal((await f.inspect()).status, 'fail'); assert.equal(f.reads.length, beforeReads);
    await fs.chmod(f.file, 0o600);
    const key = path.join(f.root, 'identity'); await fs.chmod(key, 0o644);
    assert.equal(check(await f.inspect(), 'ssh.identity').status, 'fail'); await fs.chmod(key, 0o600);
    const pem = path.join(f.tls, 'client.pem'); await fs.unlink(pem); await fs.symlink(path.join(pairs.hai, 'client.pem'), pem);
    assert.equal(check(await f.inspect(), 'tls.client.file').status, 'fail');
    await fs.unlink(f.file); await fs.symlink(path.join(f.root, 'auth.json'), f.file);
    assert.equal(check(await f.inspect(), 'config.file').status, 'fail');
  }
});

test('missing private metadata fails; Windows ACL remains explicitly unchecked', async () => {
  const f = await fixture(); await fs.unlink(path.join(f.tls, 'client.key'));
  assert.equal(check(await f.inspect(), 'tls.private_key').status, 'fail');
  const good = await fixture(), report = await good.inspect({ platform: 'win32' });
  assert.equal(report.status, 'warn'); assert.equal(check(report, 'windows_acl').status, 'warn');
  assert.ok(report.not_checked.includes('windows_acl')); safe(report);
});

test('SSH tool failure, missing or revoked trust are separate safe diagnoses', async () => {
  const f = await fixture();
  let report = await f.inspect({ run: async () => { throw Object.assign(new Error(POISON), { code: 1 }); } });
  assert.equal(check(report, 'ssh.client').status, 'fail'); assert.equal(check(report, 'ssh.trust_record').status, 'fail'); safe(report);
  report = await f.inspect({ run: async name => name === 'ssh' ? { stderr: 'OpenSSH_9.9' }
    : { stdout: '@revoked ecs.example ssh-ed25519 ' + POISON } });
  assert.equal(check(report, 'ssh.trust_record').status, 'fail'); safe(report);
});

test('occupied loopback port is a warning and its existing listener is left alive', async () => {
  const f = await fixture(), server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await fs.writeFile(f.file, JSON.stringify({ ...f.raw, local_port: server.address().port }));
    const { probeLocalPort } = await import('../src/preflight.mjs');
    const report = await f.inspect({ probe: probeLocalPort });
    assert.equal(check(report, 'port.http').status, 'warn'); assert.equal(server.listening, true); safe(report);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('safe report export is private and exclusive; existing contents are preserved', async () => {
  const f = await fixture(), out = path.join(f.root, 'report.json');
  const report = await inspectApplication({ role: 'client', file: f.file, out }, f.dependencies);
  assert.deepEqual(JSON.parse(await fs.readFile(out)), report); safe(report);
  if (process.platform !== 'win32') assert.equal((await fs.stat(out)).mode & 0o077, 0);
  await assert.rejects(inspectApplication({ role: 'client', file: f.file, out }, f.dependencies), /No existing report was overwritten/);
  assert.deepEqual(JSON.parse(await fs.readFile(out)), report);
});

test('CLI provides offline JSON with explicit synthetic config and rejects online or incompatible flags', async () => {
  const f = await fixture(), run = args => execute(process.execPath, [cli, 'inspect-app', ...args], { timeout: 10000, maxBuffer: 65536 });
  // This uses only local ssh -V/keygen -F; placeholder trust has no record, so exit 1 is expected.
  let output;
  try { output = await run(['--role', 'client', '--client-config', f.file, '--json']); }
  catch (error) { assert.equal(error.code, 1); output = error; }
  const report = JSON.parse(output.stdout); assert.equal(report.mode, 'offline'); safe(report);
  assert.ok(report.not_checked.includes('hai_availability'));
  for (const args of [['--infer'], ['--base-url', 'http://127.0.0.1:1'], ['--server-config', f.file], ['--role', 'wrong']]) {
    await assert.rejects(run(['--role', 'client', '--client-config', f.file, ...args]), error => error.code === 1 && /inspect-app requires/.test(error.stderr));
  }
  await assert.rejects(run(['--profile-dir', path.join(f.root, 'missing')]), error => error.code === 1 && /requires/.test(error.stderr));
});
