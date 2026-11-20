import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeApplicationPublisher, initializeApplicationClient, loadApplicationConfig, loadToolClient } from '../src/app-config.mjs';
import { loadClientConfig } from '../src/config.mjs';
import { loadPair } from '../src/app-identity.mjs';
import { startMockPublisher } from '../src/app-transport.mjs';
import { runApplication, applicationSshArguments, assertPortFree } from '../src/app-runtime.mjs';
import { checkApplicationClient } from '../src/app-checks.mjs';
import { buildApplicationDelivery } from '../scripts/pack-app-checks.mjs';
import { DEV_TOKEN } from '../src/dev.mjs';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/hai-bridge.mjs');
let temporary, serverInfo, sshKey, knownHosts;
const logs = [];
before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-app-cli-'));
  sshKey = path.join(temporary, 'mock-ssh-identity'); knownHosts = path.join(temporary, 'known_hosts');
  await fs.writeFile(sshKey, 'synthetic-local-SSH-stub-only', { mode: 0o600 });
  await fs.writeFile(knownHosts, '# synthetic local trust placeholder', { mode: 0o600 });
  serverInfo = await initializeApplicationPublisher(path.join(temporary, 'a'), {
    mock: true, sshTarget: 'mock@ecs.example', identityFile: sshKey, knownHostsFile: knownHosts });
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function clientConfig(name, overrides = {}) {
  const file = path.join(temporary, name + '.json');
  await initializeApplicationClient(file, { mock: true, sshTarget: 'mock@ecs.example', identityFile: sshKey,
    knownHostsFile: knownHosts, pairingDirectory: serverInfo.clientDirectory,
    localPort: await unusedPort(), tunnelPort: await unusedPort(), ...overrides });
  return { file, config: await loadApplicationConfig(file, 'client') };
}

// Actual loopback byte forwarding, not SSH encryption or real ECS. Only generated children/ports are controlled.
function tcpSshHarness(targetPort, { fatal } = {}) {
  const children = [];
  const spawnProcess = (command, args, options) => {
    assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = 0;
    children.push(child);
    if (fatal) {
      child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
      queueMicrotask(() => { child.stderr.emit('data', Buffer.from(fatal + ' PRIVATE-STDERR-FIXTURE')); child.emit('close', 255); });
      return child;
    }
    const localPort = Number(args[args.indexOf('-L') + 1].split(':')[1]);
    const sockets = new Set();
    let stopped = false;
    const server = net.createServer(incoming => {
      const outgoing = net.connect({ host: '127.0.0.1', port: targetPort });
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
        socket.once('close', () => { sockets.delete(socket); incoming.destroy(); outgoing.destroy(); });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    child.kill = () => {
      child.kills++;
      if (stopped) return true;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => child.emit('close', null));
      return true;
    };
    server.on('error', () => child.emit('close', 255));
    server.listen(localPort, '127.0.0.1');
    return child;
  };
  return { children, spawnProcess };
}

test('versioned initialization exports only B identity and imports it without A SSH credentials', async () => {
  assert.deepEqual((await fs.readdir(serverInfo.clientDirectory)).sort(), ['ca.pem', 'client.key', 'client.pem', 'pair.json']);
  const { file, config } = await clientConfig('init');
  const raw = JSON.parse(await fs.readFile(file));
  assert.equal(raw.schema_version, 1); assert.equal(raw.transport, 'app-tls'); assert.equal(raw.mode, 'mock');
  assert.equal(raw.role, 'client'); assert.equal(raw.mac_user, undefined); assert.equal(raw.upstream_auth_file, undefined);
  const tool = await loadToolClient(file, { HAI_BRIDGE_TOKEN: 'SYNTHETIC-POISON' });
  assert.equal(tool.token, DEV_TOKEN);
  assert.equal(config.pair.server_pin, (await loadPair(serverInfo.directory, 'server')).server_pin);
  assert.deepEqual((await fs.readdir(config.tlsDirectory)).sort(), ['ca.pem', 'client.key', 'client.pem', 'pair.json']);
  await assert.rejects(loadClientConfig(file), /legacy SSH/);
  await assert.rejects(initializeApplicationClient(file, { mock: true, sshTarget: 'mock@ecs.example', identityFile: sshKey,
    knownHostsFile: knownHosts, pairingDirectory: serverInfo.clientDirectory }), { code: 'EEXIST' });
  await assert.rejects(loadApplicationConfig(file, 'publisher'), /Unsupported/);
});

test('mock/version/unknown-field/port/root/unsafe file permissions are rejected before connections', async () => {
  const { file } = await clientConfig('validation');
  const original = JSON.parse(await fs.readFile(file));
  for (const change of [{ mode: 'real' }, { schema_version: 2 }, { transport: 'ssh' }, { upstream_url: 'http://127.0.0.1:6655' },
    { local_port: 22 }, { tunnel_port: original.local_port }, { reconnect: 'true' }, { max_retries: 11 },
    { ssh_target: 'root@ecs.example' }, { ssh_target: 'mock@ecs;bad' }]) {
    await fs.writeFile(file, JSON.stringify({ ...original, ...change }));
    await assert.rejects(loadApplicationConfig(file, 'client'));
  }
  await fs.writeFile(file, JSON.stringify(original));
  if (process.platform !== 'win32') {
    await fs.chmod(sshKey, 0o644); await assert.rejects(loadApplicationConfig(file, 'client'), /permissions/);
    await fs.chmod(sshKey, 0o600);
  }
  await assert.rejects(initializeApplicationPublisher(path.join(temporary, 'never-created'), { sshTarget: 'mock@ecs.example', identityFile: sshKey, knownHostsFile: knownHosts }), /mock/);
  await assert.rejects(fs.access(path.join(temporary, 'never-created')), { code: 'ENOENT' });
});

test('TLS metadata tampering and mismatched identity fail closed with no secret output', async () => {
  const { config } = await clientConfig('bad-pair');
  const pairFile = path.join(config.tlsDirectory, 'pair.json'), metadata = JSON.parse(await fs.readFile(pairFile));
  for (const change of [{ schema_version: 2 }, { server_name: 'wrong.example' }, { client_pin: '0'.repeat(64) }, { upstream_token: 'SYNTHETIC-NEVER-EXPORT' }]) {
    await fs.writeFile(pairFile, JSON.stringify({ ...metadata, ...change }));
    await assert.rejects(loadPair(config.tlsDirectory, 'client'));
  }
  await fs.writeFile(pairFile, JSON.stringify(metadata));
  await fs.writeFile(path.join(config.tlsDirectory, 'client.key'), await fs.readFile(path.join(serverInfo.directory, 'server.key')));
  await assert.rejects(loadPair(config.tlsDirectory, 'client'));
});

test('certificate file cannot smuggle an extra private key into a B delivery', async () => {
  const { config } = await clientConfig('pem-boundary');
  const ca = path.join(config.tlsDirectory, 'ca.pem');
  await fs.appendFile(ca, await fs.readFile(path.join(serverInfo.directory, 'server.key')));
  await assert.rejects(loadPair(config.tlsDirectory, 'client'), /exactly one public certificate/);
  await assert.rejects(buildApplicationDelivery({ pairingDirectory: config.tlsDirectory,
    outputRoot: path.join(temporary, 'never-pack'), npmCli: process.env.npm_execpath }), /public certificate/);
  await assert.rejects(fs.access(path.join(temporary, 'never-pack')), { code: 'ENOENT' });
  await fs.writeFile(ca, await fs.readFile(path.join(serverInfo.directory, 'ca.pem')));
  await fs.appendFile(path.join(config.tlsDirectory, 'client.key'), await fs.readFile(path.join(serverInfo.directory, 'server.key')));
  await assert.rejects(loadPair(config.tlsDirectory, 'client'), /exactly one private key/);
});

test('application SSH is isolated, non-root, loopback-only and preserves legacy guards', async () => {
  const publisher = await loadApplicationConfig(serverInfo.serverFile, 'publisher');
  const { config } = await clientConfig('args');
  const a = applicationSshArguments(publisher), b = applicationSshArguments(config);
  assert.equal(a[a.indexOf('-R') + 1], '127.0.0.1:18083:127.0.0.1:18081');
  assert.equal(b[b.indexOf('-L') + 1], '127.0.0.1:' + config.tunnelPort + ':127.0.0.1:18083');
  assert.ok(b.includes('StrictHostKeyChecking=yes') && b.includes('ForwardAgent=no'));
  assert.equal(b.some(value => value.includes('ProxyJump') || value.includes('ProxyCommand')), false);
  assert.throws(() => applicationSshArguments({ ...config, mode: 'real' }));
  assert.throws(() => applicationSshArguments({ ...config, target: 'root@ecs.example' }));
  assert.throws(() => applicationSshArguments({ ...publisher, appPort: 22 }));
});

test('formal client controller automatically rebuilds its own interrupted TCP stub; no POST replay', { timeout: 30000 }, async t => {
  const publisher = await startMockPublisher(await loadPair(serverInfo.directory, 'server'));
  t.after(() => publisher.close());
  const h = tcpSshHarness(publisher.port), { file, config } = await clientConfig('recovery');
  const reportFile = path.join(temporary, 'recovery-report.json');
  const result = await checkApplicationClient({ clientFile: file, out: reportFile, interruptSsh: true }, {
    spawnProcess: h.spawnProcess, onEvent: value => logs.push(value),
    evidence: 'local-real-TLS-TCP-stub-not-SSH' });
  assert.equal(result.report.status, 'pass', JSON.stringify(result.report));
  assert.equal(h.children.length, 2);
  assert.equal(result.report.checks.find(item => item.check === 'automatic-retry-observed').status, 'pass');
  assert.equal(publisher.stats.activeStreams, 0);
  assert.equal(logs.some(event => event.event === 'ssh' && event.state === 'retry_wait'), true);
  assert.equal(JSON.stringify(result.report).includes(DEV_TOKEN), false);
  assert.equal(JSON.stringify(result.report).includes(sshKey), false);
  await assertPortFree(config.localPort); await assertPortFree(config.tunnelPort);
  await assert.rejects(checkApplicationClient({ clientFile: file, out: reportFile, interruptSsh: true }), { code: 'EEXIST' });
});

test('without fault opt-in checks remain partial; no retry is invented', { timeout: 30000 }, async t => {
  const publisher = await startMockPublisher(await loadPair(serverInfo.directory, 'server'));
  t.after(() => publisher.close());
  const h = tcpSshHarness(publisher.port), { file } = await clientConfig('basic');
  const result = await checkApplicationClient({ clientFile: file, out: path.join(temporary, 'basic-report.json') }, {
    spawnProcess: h.spawnProcess, evidence: 'local-TCP-stub' });
  assert.equal(result.report.status, 'partial'); assert.equal(h.children.length, 1);
});

test('fatal SSH auth failure never retries or accesses mock, and reports do not include raw stderr', { timeout: 5000 }, async t => {
  const publisher = await startMockPublisher(await loadPair(serverInfo.directory, 'server'));
  t.after(() => publisher.close());
  const h = tcpSshHarness(publisher.port, { fatal: 'Permission denied (publickey).' });
  const { file } = await clientConfig('auth-fail');
  const events = [];
  const result = await checkApplicationClient({ clientFile: file, out: path.join(temporary, 'auth-fail-report.json'), interruptSsh: true }, {
    spawnProcess: h.spawnProcess, onEvent: value => events.push(value) });
  assert.equal(result.report.status, 'fail'); assert.equal(h.children.length, 1);
  assert.equal(publisher.stats.requests, 0);
  assert.equal(JSON.stringify(events).includes('PRIVATE-STDERR'), false);
  assert.equal(JSON.stringify(result.report).includes('PRIVATE-STDERR'), false);
});

test('occupied TLS port is preserved; controller never starts SSH or certifies somebody else cleanup', async t => {
  const { file, config } = await clientConfig('occupied');
  const blocker = net.createServer(); blocker.listen(config.tunnelPort, '127.0.0.1'); await once(blocker, 'listening');
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const result = await checkApplicationClient({ clientFile: file, out: path.join(temporary, 'occupied-report.json'), interruptSsh: true }, {
    spawnProcess: () => { throw new Error('MUST NOT START'); } });
  assert.equal(result.report.status, 'fail'); assert.equal(blocker.listening, true);
  assert.equal(result.report.checks.filter(item => item.status === 'not-run').length, 2);
});

test('cancellation during application startup spawns no SSH and releases its local service', async () => {
  const { config } = await clientConfig('cancel'), signals = new EventEmitter();
  let spawned = 0;
  assert.equal(await runApplication(config, { signals, onListening() { signals.emit('SIGINT'); }, spawnProcess() { spawned++; } }), 0);
  assert.equal(spawned, 0);
  assert.equal(signals.listenerCount('SIGINT'), 0); await assertPortFree(config.localPort);
});

test('publisher uses the same bounded retry controller and cleans TLS after user stop', async () => {
  const config = await loadApplicationConfig(serverInfo.serverFile, 'publisher');
  config.appPort = await unusedPort();
  const signals = new EventEmitter(), events = [], children = [];
  const code = await runApplication(config, { signals, onEvent: value => events.push(value), pause: async () => {},
    spawnProcess() {
      const child = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child);
      child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
      queueMicrotask(() => { if (children.length === 1) child.emit('close', 255); else signals.emit('SIGINT'); });
      return child;
    } });
  assert.equal(code, 0); assert.equal(children.length, 2);
  assert.ok(events.some(event => event.state === 'retry_wait'));
  await assertPortFree(config.appPort);
});

test('CLI advertises app commands and rejects missing/mock/extra options and legacy misuse before SSH', async () => {
  const { stdout } = await execute(process.execPath, [cli, '--help']);
  for (const command of ['init-app', 'init-app-client', 'publish-app', 'connect-app', 'check-app']) assert.ok(stdout.includes(command));
  for (const args of [['init-app'], ['init-app', '--mock', '--upstream-url', 'http://127.0.0.1:6655'], ['publish-app'],
    ['connect-app', '--app-port', '18081'], ['check-app'], ['connect', '--tunnel-port', '18085']]) {
    await assert.rejects(execute(process.execPath, [cli, ...args]));
  }
  const { file } = await clientConfig('cli-refuse');
  for (const args of [['connect'], ['codex'], ['probe', '--base-url', 'http://127.0.0.1:6655']]) {
    await assert.rejects(execute(process.execPath, [cli, ...args, '--client-config', file]));
  }
});

test('private B delivery contains a clean runtime and only B identity; installed CLI works off-source', { timeout: 60000 }, async () => {
  const result = await buildApplicationDelivery({ pairingDirectory: serverInfo.clientDirectory,
    outputRoot: path.join(temporary, 'delivery'), npmCli: process.env.npm_execpath });
  const { stdout } = await execute('tar', ['-tzf', result.archive]);
  const files = stdout.trim().split(String.fromCharCode(10)).filter(file => !file.endsWith('/'));
  assert.equal(files.length, 8);
  assert.equal(files.some(file => file.includes('server.key') || file.includes('ca.key') || file.includes('known_hosts')), false);
  const extracted = path.join(temporary, 'delivery-extracted'); await fs.mkdir(extracted);
  await execute('tar', ['-xzf', result.archive, '-C', extracted]);
  const bundle = path.join(extracted, 'hai-app-cli-checks'), manifest = JSON.parse(await fs.readFile(path.join(bundle, 'bundle.json')));
  const prefix = path.join(temporary, 'installed space');
  await execute(process.execPath, [process.env.npm_execpath, 'install', '--prefix', prefix, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--cache', path.join(temporary, 'npm-cache'), path.join(bundle, manifest.filename)], { timeout: 30000 });
  const installed = path.join(prefix, 'node_modules/hai-bridge/bin/hai-bridge.mjs');
  const { stdout: help } = await execute(process.execPath, [installed, '--help'], { cwd: bundle });
  assert.ok(help.includes('publish-app'));
  const out = path.join(temporary, 'installed-client.json');
  await execute(process.execPath, [installed, 'init-app-client', '--mock', '--pairing-dir', path.join(bundle, 'client-pair'),
    '--ssh-target', 'mock@ecs.example', '--identity-file', sshKey, '--known-hosts-file', knownHosts, '--out', out], { cwd: bundle });
  assert.equal((await loadApplicationConfig(out, 'client')).mode, 'mock');
});
