import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializePublisher, initializeRelayClient } from '../src/relay-config.mjs';
import { diagnoseOffline, formatOfflineReport, probeLocalPort, staticSshProfile } from '../src/preflight.mjs';

const execute = promisify(execFile);
const publicData = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString('base64');

async function seed(t, publisher = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'mac key'), jump = path.join(dir, 'jump key'), known = path.join(dir, 'known hosts');
  for (const file of [key, jump]) await fs.writeFile(file, 'KEY-CONTENTS-MUST-NEVER-BE-READ', { mode: 0o600 });
  await fs.writeFile(known, 'hai-bridge-mac ssh-ed25519 ' + publicData + '\nrelay.example.invalid ssh-ed25519 ' + publicData + '\n');
  const file = path.join(dir, 'config.json');
  if (publisher) await initializePublisher(file, { sshTarget: 'publisher@relay.example.invalid', identityFile: jump, knownHostsFile: known });
  else await initializeRelayClient(file, { mock: true, relayTarget: 'jump@relay.example.invalid', macUser: 'macuser',
    identityFile: key, relayIdentityFile: jump, knownHostsFile: known });
  const calls = [];
  const dependencies = { env: {}, homeDirectory: dir, probe: async () => {}, run: async (name, args, options) => {
    calls.push({ name, args, options });
    if (name === 'ssh') { assert.deepEqual(args, ['-V']); return { stderr: 'OpenSSH_10.0p2', stdout: '' }; }
    assert.equal(name, 'ssh-keygen');
    assert.equal(args[0], '-F');
    assert.equal(args[2], '-f');
    return { stdout: args[1] + ' ssh-ed25519 PUBLIC-RECORD-NOT-LOGGED\n' };
  } };
  return { dir, file, key, jump, known, calls, dependencies };
}
const check = (report, id) => report.checks.find(item => item.id === id);

test('offline client inspects both SSH hops without reading private keys or leaking records', async t => {
  const f = await seed(t);
  f.dependencies.files = { ...fs, readFile: async (file, encoding) => {
    assert.notEqual(file, f.key);
    assert.notEqual(file, f.jump);
    return fs.readFile(file, encoding);
  } };
  const before = await Promise.all([f.file, f.key, f.jump, f.known, f.file + '.ssh_config'].map(file => fs.readFile(file)));
  const report = await diagnoseOffline({ file: f.file }, f.dependencies);
  assert.equal(report.status, process.platform === 'win32' ? 'warn' : 'pass');
  assert.equal(report.mode, 'offline');
  for (const id of ['ssh.profile_static', 'hop_1.identity', 'hop_2.identity', 'hop_1.trust', 'hop_2.trust']) {
    assert.equal(check(report, id).status, 'pass');
  }
  assert.deepEqual(f.calls.filter(call => call.name === 'ssh-keygen').map(call => call.args[1]), ['hai-bridge-mac', 'relay.example.invalid']);
  assert.ok(report.not_checked.includes('ssh_authentication'));
  const output = JSON.stringify(report) + formatOfflineReport(report);
  for (const marker of ['KEY-CONTENTS-MUST-NEVER-BE-READ', 'PUBLIC-RECORD-NOT-LOGGED', 'hai_bridge_public_mock_token_20261119']) {
    assert.equal(output.includes(marker), false);
  }
  assert.deepEqual(await Promise.all([f.file, f.key, f.jump, f.known, f.file + '.ssh_config'].map(file => fs.readFile(file))), before);
});

test('publisher checks trust but never probes its remote relay port', async t => {
  const f = await seed(t, true);
  f.dependencies.probe = async () => assert.fail('publisher must not probe a port');
  const report = await diagnoseOffline({ file: f.file, role: 'publisher' }, f.dependencies);
  assert.equal(report.status, process.platform === 'win32' ? 'warn' : 'pass');
  assert.equal(check(report, 'remote_port').status, 'skip');
  assert.equal(check(report, 'hop_1.trust').status, 'pass');
});

test('missing and invalid configurations fail with sanitized hints', async t => {
  const f = await seed(t);
  let report = await diagnoseOffline({ file: path.join(f.dir, 'missing') }, f.dependencies);
  assert.equal(check(report, 'config.file').status, 'fail');
  for (const text of ['SECRET-MALFORMED-JSON', JSON.stringify({ bridge_token: 'SECRET-INVALID-TOKEN' })]) {
    await fs.writeFile(f.file, text);
    report = await diagnoseOffline({ file: f.file }, f.dependencies);
    assert.equal(report.status, 'fail');
    assert.equal(check(report, 'config.format').status, 'fail');
    assert.equal(JSON.stringify(report).includes('SECRET-'), false);
  }
});

test('missing key fails and Unix overbroad private-key permissions fail without repair', async t => {
  const f = await seed(t);
  await fs.unlink(f.key);
  let report = await diagnoseOffline({ file: f.file }, f.dependencies);
  assert.equal(check(report, 'hop_1.identity').status, 'fail');
  if (process.platform !== 'win32') {
    await fs.writeFile(f.key, 'PRIVATE-MARKER', { mode: 0o644 });
    report = await diagnoseOffline({ file: f.file }, f.dependencies);
    assert.equal(check(report, 'hop_1.identity.permissions').status, 'fail');
    assert.equal((await fs.stat(f.key)).mode & 0o777, 0o644);
  }
});

test('occupied or inaccessible client port is a warning, not a false connectivity diagnosis', async t => {
  const f = await seed(t);
  for (const code of ['EADDRINUSE', 'EPERM']) {
    f.dependencies.probe = async () => { throw Object.assign(new Error('RAW-PORT-ERROR'), { code }); };
    const report = await diagnoseOffline({ file: f.file }, f.dependencies);
    assert.equal(report.status, 'warn');
    assert.equal(check(report, 'local_port').status, 'warn');
    assert.equal(JSON.stringify(report).includes('RAW-PORT-ERROR'), false);
  }
});

test('offline inspector refuses executable, dynamic and ambiguous SSH profiles', async t => {
  const f = await seed(t);
  const simple = 'Host hai-bridge-mac\n  HostName 127.0.0.1\n';
  for (const suffix of ['Match exec "DO-NOT-EXECUTE"\n', 'Include other.conf\n',
    '  ProxyCommand DO-NOT-EXECUTE\n', '  IdentityFile %d/key\n', 'Host *\n',
    '  HostName duplicate\n', '  LocalCommand DO-NOT-EXECUTE\n', '  KnownHostsCommand DO-NOT-EXECUTE\n']) {
    const profile = simple + suffix;
    assert.equal(staticSshProfile(profile), undefined);
    await fs.writeFile(f.file + '.ssh_config', profile);
    f.calls.length = 0;
    const report = await diagnoseOffline({ file: f.file }, f.dependencies);
    assert.equal(check(report, 'ssh.profile_static').status, 'warn');
    assert.deepEqual(f.calls.map(call => [call.name, ...call.args]), [['ssh', '-V']]);
  }
});

test('missing profile and cyclic or unknown ProxyJump do not loop or execute commands', async t => {
  const f = await seed(t);
  await fs.unlink(f.file + '.ssh_config');
  let report = await diagnoseOffline({ file: f.file }, f.dependencies);
  assert.equal(check(report, 'ssh.profile').status, 'fail');
  for (const target of ['hai-bridge-mac', 'unknown-alias']) {
    await fs.writeFile(f.file + '.ssh_config', 'Host hai-bridge-mac\n  HostName 127.0.0.1\n  ProxyJump ' + target + '\n');
    report = await diagnoseOffline({ file: f.file }, f.dependencies);
    assert.equal(check(report, 'ssh.hops').status, 'warn');
  }
});

test('missing explicit trust record fails; revoked or failed lookups are not claimed healthy', async t => {
  const f = await seed(t, true);
  for (const scenario of ['absent', 'revoked', 'unavailable']) {
    f.dependencies.run = async (name, args) => {
      if (name === 'ssh') return { stderr: 'OpenSSH_10.0' };
      if (scenario === 'revoked') return { stdout: '@revoked\t' + args[1] + ' ssh-ed25519 PUBLIC-ONLY\n' };
      throw Object.assign(new Error('SECRET-LOOKUP-ERROR'), { code: scenario === 'absent' ? 1 : 'ENOENT' });
    };
    const report = await diagnoseOffline({ file: f.file, role: 'publisher' }, f.dependencies);
    assert.equal(check(report, 'hop_1.trust').status, scenario === 'unavailable' ? 'warn' : 'fail');
    assert.equal(JSON.stringify(report).includes('SECRET-LOOKUP-ERROR'), false);
  }
});

test('actual local ssh-keygen lookup supports hashed known_hosts and non-default ports', async t => {
  const f = await seed(t, true);
  const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
  config.ssh_port = 2222;
  await fs.writeFile(f.file, JSON.stringify(config));
  const salt = Buffer.alloc(20, 3);
  const hash = createHmac('sha1', salt).update('[relay.example.invalid]:2222').digest('base64');
  await fs.writeFile(f.known, '|1|' + salt.toString('base64') + '|' + hash + ' ssh-ed25519 ' + publicData + '\n');
  const report = await diagnoseOffline({ file: f.file, role: 'publisher' }, { ...f.dependencies, run: execute });
  assert.equal(check(report, 'hop_1.trust').status, 'pass');
});

test('legacy/global SSH config and default/agent identities remain explicitly unverified', async t => {
  const f = await seed(t);
  const raw = JSON.parse(await fs.readFile(f.file, 'utf8'));
  delete raw.ssh_config_file;
  await fs.writeFile(f.file, JSON.stringify(raw));
  const report = await diagnoseOffline({ file: f.file }, f.dependencies);
  assert.equal(check(report, 'ssh.profile_static').status, 'warn');
  assert.deepEqual(f.calls.map(call => call.name), ['ssh']);
});

test('unsupported runtime, absent SSH and Windows ACL uncertainty are reported honestly', async t => {
  const f = await seed(t, true);
  const report = await diagnoseOffline({ file: f.file, role: 'publisher' }, { ...f.dependencies,
    nodeVersion: '20.0.0', platform: 'win32', run: async () => { throw new Error('SECRET-SPAWN'); } });
  assert.equal(check(report, 'node').status, 'fail');
  assert.equal(check(report, 'ssh').status, 'fail');
  assert.equal(check(report, 'ssh.identity.permissions').status, 'warn');
  assert.equal(JSON.stringify(report).includes('SECRET-SPAWN'), false);
});

test('client token override warning does not print the token', async t => {
  const f = await seed(t), token = 'private_test_override_'.padEnd(43, 'x');
  const report = await diagnoseOffline({ file: f.file }, { ...f.dependencies, env: { HAI_BRIDGE_TOKEN: token } });
  assert.equal(check(report, 'config.token_override').status, 'warn');
  assert.equal(JSON.stringify(report).includes(token), false);
});

test('local port probe releases its own listener and does not replace an occupied one', async t => {
  const server = net.createServer(socket => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  const port = server.address().port;
  await assert.rejects(probeLocalPort(port), { code: 'EADDRINUSE' });
  assert.equal(server.listening, true);
  await new Promise(resolve => server.close(resolve));
  await probeLocalPort(port);
  await probeLocalPort(port);
});

test('offline CLI emits human/JSON reports, returns failure code and rejects mixed modes', async t => {
  const f = await seed(t, true), cli = path.resolve('bin/hai-bridge.mjs');
  const args = [cli, 'doctor', '--offline', '--publisher-config', f.file];
  const human = await execute(process.execPath, args);
  assert.ok(human.stdout.includes('OFFLINE publisher | ' + (process.platform === 'win32' ? 'WARN' : 'PASS')));
  assert.ok(human.stdout.includes('NOT CHECKED:'));
  const json = await execute(process.execPath, [...args, '--json']);
  assert.equal(JSON.parse(json.stdout).status, process.platform === 'win32' ? 'warn' : 'pass');
  await assert.rejects(execute(process.execPath, [cli, 'doctor', '--offline', '--client-config', path.join(f.dir, 'missing'), '--json']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).status, 'fail');
    return true;
  });
  for (const extra of [['--client-config', f.file], ['--base-url', 'http://127.0.0.1:1'], ['--infer']]) {
    await assert.rejects(execute(process.execPath, [...args, ...extra]), /Offline doctor accepts/);
  }
  await assert.rejects(execute(process.execPath, [cli, 'connect', '--offline']), /only supported by doctor/);
});
