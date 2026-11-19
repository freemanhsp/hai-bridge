import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkClientLifecycle, validateLifecycleConfig, runLifecycleChecks, requireFreePort } from '../src/lifecycle.mjs';
import { startMockRelay, MOCK_TOKEN } from '../explore/2026-11-19-ecs-relay/mock-relay.mjs';

const execute = promisify(execFile);
const cli = path.resolve('bin/hai-bridge.mjs');
const base = { token: MOCK_TOKEN, model: 'relay-ok', target: 'hai-bridge-mac', sshConfigFile: '/unused/test.ssh_config',
  remoteHost: '127.0.0.1', remotePort: 18080, reconnect: true, maxRetries: 2 };
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-lifecycle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t, { failSsh, replay = false, unreachable = false } = {}) {
  const mock = await startMockRelay({ port: 0, intervalMs: 15 });
  const localPort = await unusedPort(), children = [], signals = new EventEmitter(), logs = [];
  t.after(() => mock.close());
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, 'ssh'); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.signals = [];
    children.push(child);
    if (failSsh) {
      child.kill = () => false;
      queueMicrotask(() => { child.stderr.emit('data', Buffer.from(failSsh)); child.exitCode = 255; child.emit('close', 255); });
      return child;
    }
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      if (unreachable) { socket.destroy(); return; }
      const peer = net.connect(Number(new URL(mock.origin).port), '127.0.0.1');
      sockets.add(peer); peer.on('close', () => sockets.delete(peer)); peer.on('error', () => socket.destroy());
      socket.pipe(peer).pipe(socket); socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
    });
    child.server = server;
    let stopped = false;
    child.kill = signal => {
      if (stopped) return false;
      stopped = true; child.signals.push(signal);
      for (const socket of sockets) socket.destroy();
      server.close(() => { child.emit('close', null, signal); });
      return true;
    };
    server.on('error', () => { child.exitCode = 255; child.emit('close', 255); });
    server.listen(localPort, '127.0.0.1', () => {
      if (replay && children.length === 2) {
        const req = http.request(mock.origin + '/openai/v1/responses?case=json', { method: 'POST',
          headers: { Authorization: 'Bearer ' + MOCK_TOKEN }, agent: false }, res => res.resume());
        req.on('error', () => {}); req.end('{}');
      }
    });
    return child;
  };
  return { mock, children, signals, logs, config: { ...base, localPort }, dependencies: {
    spawnProcess, signals, logger: event => logs.push(JSON.parse(event)),
    stepMs: 1000, timeoutMs: 5000, requestMs: 100, pollMs: 5, quietMs: 30,
    tunnelPause: () => new Promise(resolve => setTimeout(resolve, 15)),
  } };
}

test('lifecycle refuses real/dev/unbounded configs before any SSH or HTTP', async () => {
  for (const config of [{ ...base, token: 'REAL-CREDENTIAL-DO-NOT-LOG' }, { ...base, localOnly: true },
    { ...base, remotePort: 16656 }, { ...base, target: 'other' }, { ...base, sshConfigFile: undefined },
    { ...base, reconnect: false }, { ...base, maxRetries: 100 }]) {
    assert.throws(() => validateLifecycleConfig({ ...config, localPort: 18084 }, true));
    const report = await checkClientLifecycle({ ...config, localPort: 18084 }, { interruptSsh: true }, {
      spawnProcess: () => assert.fail('must not spawn'), signals: new EventEmitter(), logger: () => {} });
    assert.equal(report.status, 'fail');
    assert.equal(report.checks.find(check => check.id === 'free_port').status, 'skip');
    assert.equal(JSON.stringify(report).includes('REAL-CREDENTIAL'), false);
  }
});

test('existing local listener is preserved and no test SSH is started', async t => {
  const server = http.createServer((_req, res) => res.end('existing-user-listener'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const localPort = server.address().port;
  const report = await checkClientLifecycle({ ...base, localPort }, {}, {
    spawnProcess: () => assert.fail('must not spawn'), logger: () => {}, signals: new EventEmitter() });
  assert.equal(report.checks.find(check => check.id === 'free_port').reason, 'local_port_unavailable');
  assert.equal(report.checks.find(check => check.id === 'port_released').status, 'skip');
  assert.equal(await (await fetch('http://127.0.0.1:' + localPort)).text(), 'existing-user-listener');
});

test('owned TCP stub demonstrates in-flight interruption, bounded retry, recovery, clean stats and released port', async t => {
  const f = await fixture(t);
  const report = await checkClientLifecycle(f.config, { interruptSsh: true }, f.dependencies);
  assert.equal(report.status, 'pass', JSON.stringify(report));
  assert.equal(report.checks.length, 9);
  assert.ok(report.checks.every(check => check.status === 'pass'));
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children.map(child => child.signals), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(f.mock.stats.activeStreams, 0); assert.equal(f.mock.stats.cancelledStreams, 1);
  assert.equal(f.mock.stats.completedStreams, 2);
  assert.ok(report.ssh_events.some(event => event.state === 'retry_wait'));
  assert.equal(report.not_checked.includes('publisher_outer_recovery'), true);
  assert.equal(JSON.stringify(report).includes(MOCK_TOKEN), false);
  assert.equal(JSON.stringify(report).includes(f.config.sshConfigFile), false);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  await requireFreePort(f.config.localPort);
});

test('default suite never injects failure and is partial instead of claiming recovery pass', async t => {
  const f = await fixture(t);
  const report = await checkClientLifecycle(f.config, {}, f.dependencies);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.checks.find(check => check.id === 'inner_recovery'),
    { id: 'inner_recovery', status: 'skip', reason: 'interrupt_not_requested' });
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('a reachable but non-mock model list is rejected before any POST', async t => {
  const f = await fixture(t), methods = [];
  f.mock.upstream.removeAllListeners('request');
  f.mock.upstream.on('request', (req, res) => {
    methods.push(req.method); req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mock: false, data: [{ id: 'relay-ok' }] }));
  });
  const report = await checkClientLifecycle(f.config, { interruptSsh: true }, f.dependencies);
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'mock_ready').reason, 'not_expected_mock');
  assert.deepEqual(methods, ['GET']);
  assert.equal(report.checks.find(check => check.id === 'unicode_sse').status, 'skip');
});

test('synthetic replay injection is detected rather than reported as healthy recovery', async t => {
  const f = await fixture(t, { replay: true });
  const report = await checkClientLifecycle(f.config, { interruptSsh: true }, f.dependencies);
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'inner_recovery').reason, 'unexpected_requests_or_replay');
  assert.equal(report.checks.find(check => check.id === 'stop_owned_ssh').status, 'pass');
  await requireFreePort(f.config.localPort);
});

test('authentication failure stops once, without raw stderr or any model request', async t => {
  const f = await fixture(t, { failSsh: 'Permission denied (publickey). SECRET-SSH-STDERR' });
  const report = await checkClientLifecycle(f.config, { interruptSsh: true }, f.dependencies);
  assert.equal(report.status, 'fail'); assert.equal(f.children.length, 1);
  assert.equal(f.mock.stats.requests, 0);
  assert.equal(report.ssh_events.at(-1).reason, 'authentication');
  assert.equal(JSON.stringify(report).includes('SECRET-SSH-STDERR'), false);
  assert.equal(report.checks.find(check => check.id === 'unicode_sse').status, 'skip');
});

test('unreachable mock times out and stops only its owned child', async t => {
  const f = await fixture(t, { unreachable: true });
  const report = await checkClientLifecycle(f.config, {}, { ...f.dependencies, stepMs: 60 });
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'mock_ready').reason, 'mock_ready_or_cleanup_timeout');
  assert.equal(report.checks.find(check => check.id === 'stop_owned_ssh').status, 'pass');
  assert.equal(f.children.length, 1);
});

test('signal cancellation records partial failure, releases its listener and removes handlers', async t => {
  const f = await fixture(t);
  const report = await checkClientLifecycle(f.config, {}, { ...f.dependencies, logger: line => {
    f.logs.push(JSON.parse(line));
    if (JSON.parse(line).id === 'unicode_sse') f.signals.emit('SIGINT');
  } });
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'new_request').reason, 'cancelled_or_deadline');
  assert.equal(report.checks.find(check => check.id === 'stop_owned_ssh').status, 'pass');
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
  await requireFreePort(f.config.localPort);
});

test('cancellation after port precheck cannot report success or start an SSH process', async t => {
  const localPort = await unusedPort(), signals = new EventEmitter();
  const report = await checkClientLifecycle({ ...base, localPort }, {}, {
    signals, spawnProcess: () => assert.fail('must not spawn'), logger: line => {
      if (JSON.parse(line).id === 'free_port') signals.emit('SIGTERM');
    } });
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'run').reason, 'cancelled_or_deadline');
  assert.equal(report.ssh_events.length, 0);
  await requireFreePort(localPort);
});

async function configFile(t, config) {
  const dir = await directory(t), file = path.join(dir, 'client.json');
  await fs.writeFile(file, JSON.stringify({ bridge_token: config.token, model: config.model,
    ssh_target: config.target, ssh_config_file: config.sshConfigFile,
    local_port: config.localPort, remote_host: config.remoteHost, remote_port: config.remotePort,
    reconnect: config.reconnect, max_retries: config.maxRetries }), { mode: 0o600 });
  return { dir, file };
}

test('report creation is exclusive, ignores credential overrides and retains safe JSON after cleanup', async t => {
  const f = await fixture(t), { dir, file } = await configFile(t, f.config), out = path.join(dir, 'report.json');
  const before = await fs.readFile(file);
  const result = await runLifecycleChecks({ clientFile: file, out, interruptSsh: true }, { ...f.dependencies,
    preflight: async (_options, dependencies) => { assert.deepEqual(dependencies.env, {}); return { status: 'pass', checks:
      ['ssh.profile_static', 'hop_1.trust', 'hop_2.trust'].map(id => ({ id, status: 'pass' })) }; } });
  assert.equal(result.report.status, 'pass');
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), result.report);
  if (process.platform !== 'win32') assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
  await assert.rejects(runLifecycleChecks({ clientFile: file, out }, { spawnProcess: () => assert.fail('must not spawn') }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(JSON.stringify(result.report).includes(MOCK_TOKEN), false);
});

test('failed offline preflight writes safe failure evidence and never starts SSH', async t => {
  const { dir, file } = await configFile(t, { ...base, localPort: 18084 }), out = path.join(dir, 'failed.json');
  const result = await runLifecycleChecks({ clientFile: file, out }, {
    spawnProcess: () => assert.fail('must not spawn'), preflight: async () => ({ status: 'fail', checks: [
      { id: 'ssh.identity', status: 'fail', message: 'SECRET-PATH-DIAGNOSTIC' }] }) });
  assert.equal(result.report.status, 'fail');
  assert.deepEqual(result.report.checks[0].failed_checks, ['ssh.identity', 'ssh.profile_static', 'hop_1.trust', 'hop_2.trust']);
  assert.equal((await fs.readFile(out, 'utf8')).includes('SECRET-PATH-DIAGNOSTIC'), false);
});

test('CLI refuses missing/extra options and real config before any SSH', async t => {
  for (const args of [[], ['--client-config', 'unused'], ['--client-config', 'unused', '--out', 'unused', '--base-url', 'http://real.invalid'],
    ['--client-config', 'unused', '--out', 'unused', '--', 'extra']]) {
    await assert.rejects(execute(process.execPath, [cli, 'check-lifecycle', ...args]), /check-lifecycle requires/);
  }
  await assert.rejects(execute(process.execPath, [cli, 'dev', '--interrupt-ssh']), /only supported by check-lifecycle/);
  const { dir, file } = await configFile(t, { ...base, token: 'DO-NOT-LOG-REAL-TOKEN'.padEnd(40, 'x'), localPort: 18084 });
  await assert.rejects(execute(process.execPath, [cli, 'check-lifecycle', '--client-config', file, '--out', path.join(dir, 'never.json')]), error => {
    assert.match(error.stderr, /mock_relay_config_required/);
    assert.equal(error.stderr.includes('DO-NOT-LOG'), false); return true;
  });
  await assert.rejects(fs.access(path.join(dir, 'never.json')), { code: 'ENOENT' });
});
