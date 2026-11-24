import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeApplicationPublisher, initializeApplicationClient, loadApplicationConfig } from '../src/app-config.mjs';
import { startHaiPublisher, listen, closeServer } from '../src/app-transport.mjs';
import { assertPortFree } from '../src/app-runtime.mjs';
import { setupClient, rememberClient, resolveDefaultClientFile, setupPublisher, defaultClientFile, defaultPublisherFile } from '../src/profiles.mjs';
import { startSession } from '../src/session.mjs';
import { runCodex } from '../src/client.mjs';
import { buildRelease } from '../scripts/pack.mjs';

const execute = promisify(execFile), sourceCli = fileURLToPath(new URL('../bin/hai-bridge.mjs', import.meta.url));
const syntheticEnv = { ...process.env, HAI_CODEX_EXECUTABLE: process.execPath };
let temporary, project, sshKey, trust, auth, upstream, info, publisher, requests = 0;
const KEY = 'synthetic-session-HAI-key';
before(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hai-session-tests-')));
  project = path.join(temporary, 'project'); await fs.mkdir(project);
  sshKey = path.join(temporary, 'ssh-key'); trust = path.join(temporary, 'trust'); auth = path.join(temporary, 'auth.json');
  await fs.writeFile(sshKey, 'synthetic-not-an-ssh-key', { mode: 0o600 });
  await fs.writeFile(trust, '# synthetic host trust', { mode: 0o600 });
  await fs.writeFile(auth, JSON.stringify({ OPENAI_API_KEY: KEY }), { mode: 0o600 });
  upstream = http.createServer((req, res) => {
    requests++; assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer ' + KEY);
    req.resume(); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'session-model' }] }));
  });
  info = await initializeApplicationPublisher(path.join(temporary, 'a'), { hai: true, model: 'session-model',
    upstreamUrl: 'http://127.0.0.1:' + await listen(upstream), upstreamAuthFile: auth,
    sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: trust });
  const config = await loadApplicationConfig(info.serverFile, 'publisher');
  publisher = await startHaiPublisher(config.pair, { config });
});
after(async () => { await publisher?.close(); await closeServer(upstream); await fs.rm(temporary, { recursive: true, force: true }); });
async function port() { const s = net.createServer(), value = await listen(s); await closeServer(s); return value; }
async function client(name) {
  const root = path.join(temporary, name); await fs.mkdir(root, { mode: 0o700 });
  const file = path.join(root, 'client.json');
  await initializeApplicationClient(file, { hai: true, pairingDirectory: info.clientDirectory, sshTarget: 'test@ecs.example',
    identityFile: sshKey, knownHostsFile: trust, localPort: await port(), tunnelPort: await port(), reconnect: false, maxRetries: 2 });
  return { file, config: await loadApplicationConfig(file, 'client') };
}
function tcpHarness(target = publisher.port) {
  const children = [];
  return { children, spawnProcess(_command, args, options) {
    assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = 0; children.push(child);
    const sockets = new Set(), local = Number(args[args.indexOf('-L') + 1].split(':')[1]);
    const server = net.createServer(incoming => {
      const outgoing = net.connect(target, '127.0.0.1');
      for (const s of [incoming, outgoing]) {
        sockets.add(s); s.on('error', () => { incoming.destroy(); outgoing.destroy(); });
        s.once('close', () => { sockets.delete(s); incoming.destroy(); outgoing.destroy(); });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    let stopped = false;
    child.finish = (code = 0, stderr = '') => {
      if (stopped) return; stopped = true;
      if (stderr) child.stderr.emit('data', stderr);
      for (const socket of sockets) socket.destroy();
      server.close(() => child.emit('close', code));
    };
    child.kill = () => { child.kills++; child.finish(); return true; };
    server.listen(local, '127.0.0.1'); return child;
  } };
}
async function released(config, signals) {
  await assertPortFree(config.localPort); await assertPortFree(config.tunnelPort);
  if (signals) { assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0); }
}

test('setup-client copies only B identity, preserves connection settings and refuses overwrite', async () => {
  const { file, config } = await client('source-profile'), root = path.join(temporary, 'stable-profile');
  const output = await setupClient(file, root), stable = await loadApplicationConfig(output, 'client');
  assert.equal(output, defaultClientFile(root)); assert.equal(stable.token, config.token); assert.equal(stable.model, config.model);
  for (const field of ['target', 'sshPort', 'identityFile', 'knownHostsFile', 'relayPort', 'localPort', 'tunnelPort', 'reconnect', 'maxRetries']) assert.equal(stable[field], config[field]);
  assert.notEqual(stable.tlsDirectory, config.tlsDirectory);
  assert.deepEqual((await fs.readdir(stable.tlsDirectory)).sort(), ['access.json', 'ca.pem', 'client.key', 'client.pem', 'pair.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(root)).mode & 0o077, 0); assert.equal((await fs.stat(output)).mode & 0o077, 0);
  }
  await assert.rejects(setupClient(file, root), { code: 'EEXIST' });
  assert.equal((await fs.readFile(output, 'utf8')).includes(KEY), false);
});

test('use-client remembers existing real config idempotently without copying keys or replacing legacy config', async () => {
  const { file, config } = await client('remember-source'), root = path.join(temporary, 'remember-default');
  await fs.mkdir(root, { mode: 0o700 });
  const legacy = defaultClientFile(root); await fs.writeFile(legacy, 'synthetic-old-profile', { mode: 0o600 });
  const original = await fs.readFile(file), before = (await fs.readdir(config.tlsDirectory)).sort(), count = requests;
  const pointer = await rememberClient(file, root), first = await fs.readFile(pointer);
  assert.equal(await rememberClient(file, root), pointer);
  assert.deepEqual(await fs.readFile(pointer), first);
  assert.equal(await resolveDefaultClientFile(root), file);
  assert.equal(await fs.readFile(legacy, 'utf8'), 'synthetic-old-profile');
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual((await fs.readdir(config.tlsDirectory)).sort(), before);
  assert.deepEqual((await fs.readdir(root)).sort(), ['client-default.json', 'client.json']);
  assert.equal(first.toString().includes(config.token), false); assert.equal(requests, count);
});

test('use-client changes only its explicit pointer; a missing selected config never falls back to legacy', async () => {
  const one = await client('remember-one'), two = await client('remember-two'), root = path.join(temporary, 'remember-switch');
  const pointer = await rememberClient(one.file, root);
  await rememberClient(two.file, root); assert.equal(await resolveDefaultClientFile(root), two.file);
  await fs.writeFile(defaultClientFile(root), 'synthetic-legacy', { mode: 0o600 });
  await fs.unlink(two.file);
  assert.equal(await resolveDefaultClientFile(root), two.file);
  let starts = 0;
  await assert.rejects(startSession({ profileDir: root, project }, { launchCodex: async () => { starts++; return 0; } }));
  assert.equal(starts, 0); assert.ok((await fs.readFile(pointer, 'utf8')).includes(two.file));
});

test('default resolution preserves legacy fallback only when no pointer exists and rejects invalid pointers', async () => {
  const root = path.join(temporary, 'remember-invalid'); await fs.mkdir(root, { mode: 0o700 });
  assert.equal(await resolveDefaultClientFile(root), defaultClientFile(root));
  const file = path.join(root, 'client-default.json');
  for (const value of ['bad-json', JSON.stringify({ schema_version: 1, role: 'client-default', client_config: 'relative.json' }),
    JSON.stringify({ schema_version: 1, role: 'client-default', client_config: project, secret: KEY })]) {
    await fs.writeFile(file, value, { mode: 0o600 });
    await assert.rejects(resolveDefaultClientFile(root), error => !error.message.includes(KEY));
  }
  if (process.platform !== 'win32') {
    await fs.writeFile(file, JSON.stringify({ schema_version: 1, role: 'client-default', client_config: project }));
    await fs.chmod(file, 0o644); await assert.rejects(resolveDefaultClientFile(root));
    await fs.chmod(file, 0o600); const target = file + '.saved'; await fs.rename(file, target);
    await fs.symlink(target, file); await assert.rejects(resolveDefaultClientFile(root));
    await assert.rejects(rememberClient((await client('remember-link-source')).file, root));
  }
});

test('start reads its explicitly selected default and keeps config outside the project', async () => {
  const { file, config } = await client('selected-start'), root = path.join(temporary, 'selected-start-default'), h = tcpHarness();
  await rememberClient(file, root); let launched = 0;
  assert.equal(await startSession({ profileDir: root, project }, { runtimeOptions: { spawnProcess: h.spawnProcess },
    launchCodex: async () => { launched++; return 0; } }), 0);
  assert.equal(launched, 1); await released(config);
  await assert.rejects(startSession({ profileDir: root, project: path.dirname(file) }), /outside/);
});

test('setup rejects unsafe roots/mock clients; publisher pointer is local and non-overwriting', async () => {
  const { file } = await client('profile-validation'), pointerRoot = path.join(temporary, 'publisher-default');
  const count = requests; await setupPublisher(info.serverFile, pointerRoot);
  assert.equal(await defaultPublisherFile(pointerRoot), info.serverFile); assert.equal(requests, count);
  await assert.rejects(setupPublisher(info.serverFile, pointerRoot), { code: 'EEXIST' });
  const pointer = path.join(pointerRoot, 'publisher-default.json'), original = await fs.readFile(pointer);
  await fs.writeFile(pointer, JSON.stringify({ schema_version: 1, transport: 'app-tls', role: 'publisher-default', server_config: 'relative.json' }));
  await assert.rejects(defaultPublisherFile(pointerRoot), /Invalid publisher/); await fs.writeFile(pointer, original);
  if (process.platform !== 'win32') {
    await fs.chmod(pointer, 0o644); await assert.rejects(defaultPublisherFile(pointerRoot), /No safe default/); await fs.chmod(pointer, 0o600);
    const publicRoot = path.join(temporary, 'public-profile'); await fs.mkdir(publicRoot, { mode: 0o755 });
    await assert.rejects(setupClient(file, publicRoot), /private/);
    const linked = path.join(temporary, 'linked-profile'); await fs.symlink(pointerRoot, linked);
    await assert.rejects(setupClient(file, linked), /symlink/);
  }
  const mock = await initializeApplicationPublisher(path.join(temporary, 'mock-a'), { mock: true, sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: trust });
  const mockFile = path.join(temporary, 'mock-client.json');
  await initializeApplicationClient(mockFile, { mock: true, pairingDirectory: mock.clientDirectory, sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: trust });
  await assert.rejects(setupClient(mockFile, path.join(temporary, 'forbidden-mock')), /not mock/);
  await assert.rejects(startSession({ clientFile: mockFile, project }), /real HAI/);
});

test('start owns one pinned TLS connection and Codex in project cwd with token only in child env', async () => {
  const { file, config } = await client('normal-session'), h = tcpHarness(), signals = new EventEmitter(), events = [];
  let calls = 0, captured;
  const code = await startSession({ clientFile: file, project, userArgs: ['--help'] }, { env: syntheticEnv, signals, onEvent: e => events.push(e),
    runtimeOptions: { spawnProcess: h.spawnProcess }, codexOptions: { spawnProcess(command, args, options) {
      calls++; captured = { command, args, options }; const child = new EventEmitter(); child.kill = () => assert.fail('completed child must not be killed');
      process.nextTick(() => child.emit('close', 0)); return child;
    } } });
  assert.equal(code, 0); assert.equal(calls, 1); assert.equal(h.children.length, 1);
  assert.equal(captured.options.cwd, project); assert.equal(captured.options.env.HAI_BRIDGE_TOKEN, config.token);
  assert.equal(captured.options.shell, false); assert.ok(captured.args.includes('--no-daemon'));
  assert.equal(JSON.stringify(captured.args).includes(config.token), false);
  assert.equal(JSON.stringify(events).includes(config.token), false); assert.equal(JSON.stringify(events).includes(KEY), false);
  assert.deepEqual(events.filter(e => e.event === 'session').map(e => e.state), ['connecting', 'ready', 'codex_starting', 'stopped']);
  await released(config, signals);
});

test('session observer failure after readiness closes its own B connection without launching Codex', { timeout: 3000 }, async () => {
  const { file, config } = await client('observer-session'), h = tcpHarness(), signals = new EventEmitter(); let calls = 0;
  await assert.rejects(startSession({ clientFile: file, project }, { signals, runtimeOptions: { spawnProcess: h.spawnProcess },
    onEvent(event) { if (event.event === 'session' && event.state === 'ready') return Promise.reject(new Error('SYNTHETIC-SECRET')); },
    launchCodex: async () => { calls++; return 0; },
  }), error => /Cannot start session/.test(error.message) && !error.message.includes('SYNTHETIC-SECRET'));
  assert.equal(calls, 0); assert.equal(h.children.length, 1); assert.equal(h.children[0].kills, 1);
  await released(config, signals);
});

test('start preserves nonzero Codex exit and frees own listeners', async () => {
  const { file, config } = await client('nonzero-session'), h = tcpHarness();
  assert.equal(await startSession({ clientFile: file, project }, { runtimeOptions: { spawnProcess: h.spawnProcess }, launchCodex: async () => 7 }), 7);
  await released(config);
});
test('start refuses pairing-directory cwd including symlinks before any connection', async () => {
  const { file, config } = await client('private-cwd'), h = tcpHarness();
  await assert.rejects(startSession({ clientFile: file, project: config.tlsDirectory }, { runtimeOptions: { spawnProcess: h.spawnProcess } }), /outside/);
  if (process.platform !== 'win32') {
    const link = path.join(temporary, 'project-link'); await fs.symlink(config.tlsDirectory, link);
    await assert.rejects(startSession({ clientFile: file, project: link }), /outside/);
  }
  assert.equal(h.children.length, 0);
});

test('Ctrl-C during TLS startup releases both ports without launching Codex', async () => {
  const { file, config } = await client('startup-cancel'), h = tcpHarness(await port()), signals = new EventEmitter();
  let launched = false;
  const result = await startSession({ clientFile: file, project }, { signals, runtimeOptions: { spawnProcess: h.spawnProcess },
    onEvent(e) { if (e.event === 'application' && e.state === 'listening') setTimeout(() => signals.emit('SIGINT'), 50); },
    launchCodex: async () => { launched = true; return 0; } });
  assert.equal(result, 130); assert.equal(launched, false); await released(config, signals);
});

test('Ctrl-C before runtime construction does not orphan a connection', async () => {
  const { file, config } = await client('early-cancel'), h = tcpHarness(), signals = new EventEmitter();
  const result = await startSession({ clientFile: file, project }, { signals, runtimeOptions: { spawnProcess: h.spawnProcess },
    onEvent(e) { if (e.event === 'session' && e.state === 'connecting') signals.emit('SIGINT'); } });
  assert.equal(result, 130); assert.equal(h.children.length, 0); await released(config, signals);
});

test('Ctrl-C during Codex stops exactly the owned child and connection', async () => {
  const { file, config } = await client('active-cancel'), h = tcpHarness(), signals = new EventEmitter(); let kills = 0;
  const code = await startSession({ clientFile: file, project }, { env: syntheticEnv, signals, runtimeOptions: { spawnProcess: h.spawnProcess },
    codexOptions: { spawnProcess() {
      const child = new EventEmitter(); child.kill = () => { kills++; process.nextTick(() => child.emit('close', null, 'SIGTERM')); return true; };
      setTimeout(() => signals.emit('SIGINT'), 20); return child;
    } } });
  assert.equal(code, 130); assert.equal(kills, 1); assert.equal(h.children.length, 1); await released(config, signals);
});

test('fatal SSH authentication exit stops Codex once and never restarts it', async () => {
  const { file, config } = await client('fatal-ssh'), h = tcpHarness(); let starts = 0, kills = 0;
  const code = await startSession({ clientFile: file, project }, { env: syntheticEnv, runtimeOptions: { spawnProcess: h.spawnProcess },
    codexOptions: { spawnProcess() {
      starts++; const child = new EventEmitter(); child.kill = () => { kills++; process.nextTick(() => child.emit('close', null)); return true; };
      setTimeout(() => h.children[0].finish(255, 'Permission denied (publickey)'), 10); return child;
    } } });
  assert.equal(code, 1); assert.equal(starts, 1); assert.equal(kills, 1); assert.equal(h.children.length, 1); await released(config);
});

test('foreign HTTP or tunnel listener is never adopted or stopped on port conflict', async () => {
  for (const kind of ['localPort', 'tunnelPort']) {
    const { file, config } = await client('conflict-' + kind), foreign = net.createServer();
    await listen(foreign, config[kind]);
    try {
      const h = tcpHarness();
      await assert.rejects(startSession({ clientFile: file, project }, { runtimeOptions: { spawnProcess: h.spawnProcess } }), /already in use/);
      assert.equal(foreign.listening, true); assert.equal(h.children.length, 0);
    } finally { await closeServer(foreign); }
    await released(config);
  }
});

test('missing Codex executable frees connection and removes signal handlers', async () => {
  const { file, config } = await client('codex-missing'), h = tcpHarness(), signals = new EventEmitter();
  await assert.rejects(startSession({ clientFile: file, project }, { signals, runtimeOptions: { spawnProcess: h.spawnProcess },
    env: { ...process.env, HAI_CODEX_EXECUTABLE: path.join(temporary, 'missing-codex-executable') } }), /Codex installation/);
  await released(config, signals);
});

test('daily CLI rejects missing setup, invalid flags and unsafe argument combinations before connecting', async () => {
  for (const args of [['setup-client'], ['use-client'], ['use-client', '--client-config', 'unused', '--', 'exec'], ['setup-publisher'], ['start', '--mock'], ['start', '--json'],
    ['setup-client', '--client-config', 'unused', '--', 'exec'], ['doctor', '--profile-dir', temporary],
    ['publish-app', '--profile-dir', path.join(temporary, 'missing-default')]]) {
    await assert.rejects(execute(process.execPath, [sourceCli, ...args], { cwd: project }), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /HAI Bridge:/); assert.equal(error.stderr.includes(KEY), false); return true;
    });
  }
});

test('TLS startup timeout stops its own connection without starting Codex', async () => {
  const { file, config } = await client('tls-timeout'), h = tcpHarness(await port()); let launched = false;
  await assert.rejects(startSession({ clientFile: file, project }, { runtimeOptions: { spawnProcess: h.spawnProcess },
    waitOptions: { timeoutMs: 100 }, launchCodex: async () => { launched = true; return 0; } }), /Cannot start session/);
  assert.equal(launched, false); assert.equal(h.children.length, 1); await released(config);
});

test('Windows termination targets only own live child; repeated stops and exited PIDs are ignored', async () => {
  const signals = new EventEmitter(), abort = new AbortController(); let treeStops = 0;
  const child = new EventEmitter(); child.pid = 123456; child.kill = () => assert.fail('tree handler should own termination');
  const result = runCodex({ token: 'synthetic-child-token', model: 'session-model' }, 'http://127.0.0.1:18084', [], syntheticEnv, {
    platform: 'win32', signals, signal: abort.signal, spawnProcess: () => child,
    terminateTree(value) { assert.equal(value, child); treeStops++; process.nextTick(() => child.emit('close', null)); } });
  await new Promise(resolve => setImmediate(resolve));
  signals.emit('SIGINT'); abort.abort(); signals.emit('SIGTERM');
  assert.equal(await result, 130); assert.equal(treeStops, 1); assert.equal(signals.listenerCount('SIGTERM'), 0);
  const exitedChild = new EventEmitter(); exitedChild.pid = 123457; exitedChild.kill = () => assert.fail('exited child PID must not be killed');
  const exited = runCodex({ token: 'synthetic-child-token', model: 'session-model' }, 'http://127.0.0.1:18084', [], syntheticEnv, {
    platform: 'win32', signals, spawnProcess: () => exitedChild, terminateTree: () => assert.fail('PID is not live') });
  await new Promise(resolve => setImmediate(resolve));
  exitedChild.emit('exit', 0); signals.emit('SIGINT'); exitedChild.emit('close', 0); assert.equal(await exited, 0);
});

test('Windows tree-termination failure falls back safely; pre-aborted Codex never spawns', async () => {
  const signals = new EventEmitter(); let kills = 0, spawned = 0;
  const child = new EventEmitter(); child.pid = 123458; child.kill = () => { kills++; process.nextTick(() => child.emit('close', null)); return true; };
  const result = runCodex({ token: 'synthetic-child-token', model: 'session-model' }, 'http://127.0.0.1:18084', [], syntheticEnv, {
    platform: 'win32', signals, spawnProcess: () => child, terminateTree: () => { throw new Error('synthetic termination error'); } });
  await new Promise(resolve => setImmediate(resolve)); signals.emit('SIGTERM');
  assert.equal(await result, 130); assert.equal(kills, 1);
  assert.equal(await runCodex({}, '', [], process.env, { signal: AbortSignal.abort(), spawnProcess: () => { spawned++; } }), 130);
  assert.equal(spawned, 0);
});

test('offline installed package can setup and start one synthetic Codex off-source', { timeout: 60000, skip: process.platform === 'win32' }, async () => {
  const { file, config } = await client('package-source'), release = await buildRelease({ outputRoot: path.join(temporary, 'artifacts') });
  const prefix = path.join(temporary, 'install');
  await execute(process.execPath, [process.env.npm_execpath, 'install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', path.join(temporary, 'npm-cache'), release.archive], { timeout: 30000 });
  const cli = path.join(prefix, 'node_modules/hai-bridge/bin/hai-bridge.mjs'), profile = path.join(temporary, 'installed-profile');
  await execute(process.execPath, [cli, 'setup-client', '--client-config', file, '--profile-dir', profile], { cwd: project });
  const shimRoot = path.join(temporary, 'fake-bin'); await fs.mkdir(shimRoot);
  await fs.writeFile(path.join(shimRoot, 'ssh'), '#!' + process.execPath + '\n' + [
    "import net from 'node:net';",
    "const args=process.argv, port=Number(args[args.indexOf('-L')+1].split(':')[1]);",
    'const sockets=new Set();',
    'const server=net.createServer(a=>{const b=net.connect(' + publisher.port + ",'127.0.0.1');",
    "for(const s of [a,b]) { sockets.add(s); s.on('error',()=>{a.destroy();b.destroy();}); s.once('close',()=>{sockets.delete(s);a.destroy();b.destroy();}); }",
    'a.pipe(b).pipe(a);});', "server.listen(port,'127.0.0.1');",
    "process.on('SIGTERM',()=>{for(const s of sockets)s.destroy();server.close(()=>process.exit(0));});",
  ].join('\n'), { mode: 0o700 });
  const codex = path.join(temporary, 'synthetic-codex.mjs'), report = path.join(temporary, 'codex-report.json');
  await fs.writeFile(codex, "import fs from 'node:fs';\nfs.writeFileSync(process.env.HAI_TEST_REPORT,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),hasToken:!!process.env.HAI_BRIDGE_TOKEN}));\n");
  const { stdout, stderr } = await execute(process.execPath, [cli, 'start', '--profile-dir', profile, '--', '--help'], { cwd: project, timeout: 20000,
    env: { ...process.env, PATH: shimRoot + path.delimiter + process.env.PATH, HAI_CODEX_EXECUTABLE: codex, HAI_TEST_REPORT: report } });
  const captured = JSON.parse(await fs.readFile(report));
  assert.equal(captured.cwd, project); assert.equal(captured.hasToken, true); assert.ok(captured.args.includes('--help'));
  assert.match(stderr, /HAI session: stopped/); assert.equal((stdout + stderr + JSON.stringify(captured.args)).includes(config.token), false);
  await released(config);
});
