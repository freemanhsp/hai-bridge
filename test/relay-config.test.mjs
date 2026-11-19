import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializePublisher, loadPublisherConfig, initializeRelayClient, MOCK_RELAY_TOKEN } from '../src/relay-config.mjs';
import { loadClientConfig, sshValue } from '../src/config.mjs';
import { sshArguments } from '../src/tunnel.mjs';

const execute = promisify(execFile);
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-relay-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function options(dir) {
  return { mock: true, relayTarget: 'jump@relay.example.invalid', macUser: 'macuser',
    relayIdentityFile: path.join(dir, 'jump key'), identityFile: path.join(dir, 'mac key'),
    knownHostsFile: path.join(dir, 'known hosts') };
}

test('publisher initializes private config, fixes SSH destination, and refuses overwrite', async t => {
  const dir = await directory(t), file = path.join(dir, 'publisher.json');
  await initializePublisher(file, { sshTarget: 'publisher@relay.example.invalid', relayPort: 19083,
    identityFile: path.join(dir, 'key'), knownHostsFile: path.join(dir, 'known') });
  const config = await loadPublisherConfig(file);
  assert.equal(config.direction, 'remote');
  assert.equal(config.remoteHost, '127.0.0.1');
  assert.equal(config.remotePort, 22);
  assert.equal(config.localPort, 19083);
  assert.equal(sshArguments(config)[sshArguments(config).indexOf('-R') + 1], '127.0.0.1:19083:127.0.0.1:22');
  await assert.rejects(initializePublisher(file, { sshTarget: 'publisher@relay.example.invalid' }), { code: 'EEXIST' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('publisher and generated profiles reject root, injection, control characters and bad ports', async t => {
  const dir = await directory(t);
  for (const target of ['root@relay', 'relay', 'user@relay\nProxyCommand bad', 'user@-host', 'user@']) {
    await assert.rejects(initializePublisher(path.join(dir, 'invalid.json'), { sshTarget: target }));
  }
  await assert.rejects(initializePublisher(path.join(dir, 'invalid.json'), { sshTarget: 'user@relay', relayPort: 0 }));
  for (const value of ['', 'a\nHost bad', 'a\r', 'a\0b']) assert.throws(() => sshValue(value));
  await assert.rejects(initializeRelayClient(path.join(dir, 'bad.json'), { ...options(dir), macUser: 'mac\nHost bad' }));
  await assert.rejects(initializeRelayClient(path.join(dir, 'bad.json'), { ...options(dir), identityFile: 'key\nProxyCommand bad' }));
});

test('mock relay client uses separate identities and dedicated profile without real credentials', async t => {
  const dir = await directory(t), out = path.join(dir, 'mock.json'), input = options(dir);
  await fs.writeFile(input.identityFile, 'PRIVATE-CONTENT-NEVER-COPY');
  const result = await initializeRelayClient(out, input);
  const config = await loadClientConfig(out, {});
  const profile = await fs.readFile(result.sshConfigFile, 'utf8');
  assert.equal(config.token, MOCK_RELAY_TOKEN);
  assert.equal(config.localPort, 18084);
  assert.equal(config.remotePort, 18080);
  assert.equal(config.model, 'relay-ok');
  assert.equal(config.target, 'hai-bridge-mac');
  assert.equal(config.sshConfigFile, result.sshConfigFile);
  assert.ok(profile.includes('ProxyJump hai-bridge-relay'));
  assert.ok(profile.includes('HostKeyAlias hai-bridge-mac'));
  assert.ok(profile.includes(sshValue(input.relayIdentityFile)));
  assert.ok(profile.includes(sshValue(input.identityFile)));
  assert.equal(profile.includes(MOCK_RELAY_TOKEN), false);
  assert.equal(profile.includes('PRIVATE-CONTENT-NEVER-COPY'), false);
  assert.equal(profile.match(/StrictHostKeyChecking yes/g).length, 2);
  assert.equal(profile.match(/ConnectTimeout 10/g).length, 2);
  assert.equal(profile.match(/ServerAliveInterval 15/g).length, 2);
  if (process.platform !== 'win32') {
    for (const file of [out, result.sshConfigFile]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  const resolved = await execute('ssh', ['-G', '-F', result.sshConfigFile, 'hai-bridge-mac']);
  assert.ok(resolved.stdout.includes('proxyjump hai-bridge-relay'));
  assert.ok(resolved.stdout.includes('user macuser'));
  assert.ok(resolved.stdout.includes('port 18083'));
  const jump = await execute('ssh', ['-G', '-F', result.sshConfigFile, 'hai-bridge-relay']);
  assert.ok(jump.stdout.includes('user jump'));
});

test('initialization preserves existing client/profile files, including orphan profiles', async t => {
  const dir = await directory(t), out = path.join(dir, 'client.json');
  await fs.writeFile(out, 'USER-FILE');
  await assert.rejects(initializeRelayClient(out, options(dir)), /already exists/);
  assert.equal(await fs.readFile(out, 'utf8'), 'USER-FILE');
  await assert.rejects(fs.access(out + '.ssh_config'), { code: 'ENOENT' });
  const other = path.join(dir, 'other.json');
  await fs.writeFile(other + '.ssh_config', 'USER-PROFILE');
  await assert.rejects(initializeRelayClient(other, options(dir)), /already exists/);
  assert.equal(await fs.readFile(other + '.ssh_config', 'utf8'), 'USER-PROFILE');
  await assert.rejects(fs.access(other), { code: 'ENOENT' });
});

test('real relay initialization imports only a bridge pairing and requires an explicit mode', async t => {
  const dir = await directory(t), pairing = path.join(dir, 'pairing.json');
  const token = 'p'.repeat(43);
  await fs.writeFile(pairing, JSON.stringify({ bridge_token: token, ssh_target: 'old@mac', local_port: 16655,
    remote_host: '127.0.0.1', remote_port: 16656, model: 'example-model', reconnect: true, max_retries: 5,
    ignored_sso: 'NOT-EXPORTED' }));
  const input = { ...options(dir), mock: false, pairingFile: pairing };
  const out = path.join(dir, 'real.json');
  await initializeRelayClient(out, input);
  const config = await loadClientConfig(out, {});
  assert.equal(config.token, token);
  assert.equal(config.remotePort, 16656);
  assert.equal((await fs.readFile(out, 'utf8')).includes('NOT-EXPORTED'), false);
  await assert.rejects(initializeRelayClient(path.join(dir, 'missing.json'), { ...input, pairingFile: undefined }), /pairing-file/);
  await assert.rejects(initializeRelayClient(path.join(dir, 'both.json'), { ...input, mock: true }), /not both/);
});

test('extended SSH options resolve relative paths and reject unsafe values', async t => {
  const dir = await directory(t), out = path.join(dir, 'client.json');
  const raw = { bridge_token: MOCK_RELAY_TOKEN, ssh_target: 'mac', local_port: 18084, remote_host: '127.0.0.1',
    remote_port: 18080, model: 'relay-ok', reconnect: true, max_retries: 5,
    ssh_port: 18083, ssh_config_file: 'profile with spaces', known_hosts_file: 'hosts', ssh_host_key_alias: 'pinned-mac' };
  await fs.writeFile(out, JSON.stringify(raw));
  const config = await loadClientConfig(out, {});
  assert.equal(config.sshConfigFile, path.join(dir, 'profile with spaces'));
  assert.equal(config.knownHostsFile, path.join(dir, 'hosts'));
  assert.equal(config.sshPort, 18083);
  for (const change of [{ ssh_port: 0 }, { ssh_host_key_alias: 'bad alias' }, { ssh_config_file: 'file\nHost bad' }]) {
    await fs.writeFile(out, JSON.stringify({ ...raw, ...change }));
    await assert.rejects(loadClientConfig(out, {}));
  }
});

test('CLI relay initialization works offline and never prints pairing credentials', async t => {
  const dir = await directory(t), out = path.join(dir, 'client.json');
  const cli = path.resolve('bin/hai-bridge.mjs');
  const result = await execute(process.execPath, [cli, 'init-relay-client', '--mock', '--out', out,
    '--relay-target', 'jump@relay.example.invalid', '--mac-user', 'macuser',
    '--relay-identity-file', path.join(dir, 'jump key'), '--identity-file', path.join(dir, 'mac key')]);
  assert.ok(result.stdout.includes('MOCK ONLY'));
  assert.equal(result.stdout.includes(MOCK_RELAY_TOKEN), false);
  assert.equal((await loadClientConfig(out, {})).model, 'relay-ok');
});
