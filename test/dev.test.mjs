import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDevelopment, runDevelopment, formatDevelopmentReady, DEV_TOKEN } from '../src/dev.mjs';
import { loadClientConfig } from '../src/config.mjs';
import { diagnose, probeInference } from '../src/client.mjs';
import { diagnoseOffline } from '../src/preflight.mjs';
import { sshArguments } from '../src/tunnel.mjs';
import { initializeRelayClient } from '../src/relay-config.mjs';

const execute = promisify(execFile);
const cli = path.resolve('bin/hai-bridge.mjs');
const serverCount = () => process.getActiveResourcesInfo().filter(type => type === 'TCPServerWrap').length;
async function fixture(t, options = {}) {
  const logs = [];
  const service = await startDevelopment({ port: 0, intervalMs: 20, logger: event => logs.push(event), ...options });
  t.after(() => service.close());
  return { ...service, logs, headers: { Authorization: 'Bearer ' + DEV_TOKEN } };
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-dev-tests-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function settled(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(10);
  assert.ok(predicate(), 'condition did not settle');
}

test('dev starts real bridge and mock only on loopback with an isolated private temporary client', async t => {
  const f = await fixture(t), config = await loadClientConfig(f.clientFile, {});
  assert.equal(f.bridge.address().address, '127.0.0.1');
  assert.equal(f.upstream.address().address, '127.0.0.1');
  assert.equal(config.localPort, Number(new URL(f.origin).port));
  assert.equal(config.localOnly, true);
  assert.equal(config.token, DEV_TOKEN);
  assert.equal(config.reconnect, false);
  assert.equal(f.temporary, true);
  assert.equal(path.dirname(f.clientFile).startsWith(os.tmpdir()), true);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.clientFile)).mode & 0o777, 0o600);
  const result = await diagnose(config, f.origin);
  assert.equal(result.mock, true);
  assert.equal(result.hai, 'not_checked');
  assert.equal(result.configured_model_available, true);
});

test('dev authentication/path restrictions use the real bridge and discard synthetic input', async t => {
  const f = await fixture(t);
  for (const token of ['', 'wrong-test-token']) {
    const response = await fetch(f.origin + '/openai/v1/models', { headers: { Authorization: token } });
    assert.equal(response.status, 401);
  }
  assert.equal(f.stats.requests, 0);
  const blocked = await fetch(f.origin + '/admin', { headers: f.headers });
  assert.equal(blocked.status, 404);
  const response = await fetch(f.origin + '/openai/v1/responses?case=json', { method: 'POST',
    headers: f.headers, body: 'INPUT-MARKER-NEVER-ECHO-OR-LOG' });
  assert.deepEqual(await response.json(), { mock: true, output: 'relay-ok 中文' });
  assert.equal(f.stats.rejectedAuth, 0);
  assert.equal(JSON.stringify(f.logs).includes('INPUT-MARKER-NEVER-ECHO-OR-LOG'), false);
  assert.equal(JSON.stringify(f.logs).includes(DEV_TOKEN), false);
});

test('dev Unicode SSE is incremental and existing probe reports zero synthetic token usage', async t => {
  const f = await fixture(t, { intervalMs: 80 });
  const response = await fetch(f.origin + '/openai/v1/responses', { method: 'POST', headers: f.headers });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });
  assert.match(text, /relay-/);
  assert.equal(f.stats.completedStreams, 0);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  assert.match(text, / 中文/);
  assert.match(text, /response.completed/);
  const probe = await probeInference(await loadClientConfig(f.clientFile, {}), f.origin, 'relay-ok');
  assert.equal(probe.completed, true);
  assert.equal(probe.input_tokens, 0);
  assert.equal(probe.output_tokens, 0);
});

test('dev synthetic error and timeout scenarios retain HTTP status and never replay POST', async t => {
  const f = await fixture(t, { idleTimeoutMs: 100 });
  for (const [scenario, status, code] of [['429', 429, 'mock_429'], ['503', 503, 'mock_503'],
    ['stall', 504, 'upstream_timeout'], ['disconnect', 502, 'upstream_unavailable'], ['unknown', 400, 'mock_case_not_supported']]) {
    const before = f.stats.requests;
    const response = await fetch(f.origin + '/openai/v1/responses?case=' + scenario, { method: 'POST', headers: f.headers });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    if ([429, 503].includes(status)) assert.equal(response.headers.get('retry-after'), '7');
    assert.equal(f.stats.requests, before + 1);
  }
});

test('dev cancellation and repeated close clean timers, streams, listeners and only temporary config', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/openai/v1/responses?case=cancel', { method: 'POST', headers: f.headers });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await settled(() => f.stats.cancelledStreams === 1 && f.stats.activeStreams === 0);
  assert.equal(f.stats.completedStreams, 0);
  const second = await fetch(f.origin + '/openai/v1/responses?case=cancel', { method: 'POST', headers: f.headers });
  const secondReader = second.body.getReader();
  await secondReader.read();
  await Promise.all([f.close(), f.close()]);
  await secondReader.cancel().catch(() => {});
  await settled(() => f.stats.activeStreams === 0 && f.stats.cancelledStreams === 2);
  assert.equal(f.bridge.listening, false);
  assert.equal(f.upstream.listening, false);
  await assert.rejects(fs.access(f.clientFile), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.dirname(f.clientFile)), { code: 'ENOENT' });
});

test('persistent dev output survives shutdown and existing user files are never overwritten', async t => {
  const dir = await directory(t), out = path.join(dir, 'client.json');
  const f = await fixture(t, { out });
  const before = await fs.readFile(out, 'utf8');
  assert.equal(f.temporary, false);
  await f.close();
  assert.equal(await fs.readFile(out, 'utf8'), before);
  await assert.rejects(startDevelopment({ port: 0, out }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(out, 'utf8'), before);
  const userFile = path.join(dir, 'user.json');
  await fs.writeFile(userFile, 'USER-OWNED-CONTENT');
  await assert.rejects(startDevelopment({ port: 0, out: userFile }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(userFile, 'utf8'), 'USER-OWNED-CONTENT');
});

test('port conflict rollback closes its own upstream and preserves the original listener', async t => {
  const existing = http.createServer((_req, res) => res.end('existing-listener'));
  existing.listen(0, '127.0.0.1');
  await once(existing, 'listening');
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const before = serverCount();
  await assert.rejects(startDevelopment({ port: existing.address().port }), { code: 'EADDRINUSE' });
  await delay(20);
  assert.equal(serverCount(), before);
  assert.equal(await (await fetch('http://127.0.0.1:' + existing.address().port)).text(), 'existing-listener');
  existing.closeAllConnections();
});

test('configuration write failure rolls back both listeners and its new temporary directory', async () => {
  // A previous server close callback can resolve one turn before its native handle disappears.
  await delay(20);
  const before = serverCount();
  let attemptedFile;
  await assert.rejects(startDevelopment({ port: 0 }, { writeConfig: async file => {
    attemptedFile = file;
    throw new Error('SYNTHETIC-WRITE-ERROR');
  } }), /SYNTHETIC-WRITE-ERROR/);
  await delay(20);
  assert.equal(serverCount(), before);
  await assert.rejects(fs.access(path.dirname(attemptedFile)), { code: 'ENOENT' });
});

test('local-only client skips offline SSH checks and rejects connect before spawning SSH', async t => {
  const f = await fixture(t), dir = await directory(t);
  const config = await loadClientConfig(f.clientFile, {});
  assert.throws(() => sshArguments(config), /Local-only development/);
  await assert.rejects(initializeRelayClient(path.join(dir, 'relay.json'), { pairingFile: f.clientFile,
    relayTarget: 'jump@relay.example.invalid', macUser: 'macuser',
    identityFile: path.join(dir, 'unused-mac-key'), relayIdentityFile: path.join(dir, 'unused-jump-key') }), /Local-only development/);
  const report = await diagnoseOffline({ file: f.clientFile }, { env: {}, run: async () => assert.fail('SSH must not run'), probe: async () => {} });
  assert.equal(report.checks.find(check => check.id === 'ssh').status, 'skip');
  assert.equal(report.checks.find(check => check.id === 'ssh.profile_static').status, 'skip');
  await assert.rejects(execute(process.execPath, [cli, 'connect', '--client-config', f.clientFile],
    { env: { ...process.env, PATH: dir, HAI_BRIDGE_TOKEN: '' } }), /Local-only dev configuration does not use SSH/);
});

test('dev validates options and local_only type without using real configuration options', async t => {
  for (const options of [{ port: -1 }, { port: 65536 }, { intervalMs: 0 }, { idleTimeoutMs: 0 }, { out: 'bad\npath' }]) {
    await assert.rejects(startDevelopment(options));
  }
  for (const options of [['--server-config', 'DO-NOT-READ'], ['--upstream-url', 'http://real.invalid'],
    ['--client-config', 'DO-NOT-READ'], ['--identity-file', 'DO-NOT-READ'], ['--', 'extra']]) {
    await assert.rejects(execute(process.execPath, [cli, 'dev', ...options]), /dev accepts only/);
  }
  const f = await fixture(t), raw = JSON.parse(await fs.readFile(f.clientFile, 'utf8'));
  raw.local_only = 'yes';
  await fs.writeFile(f.clientFile, JSON.stringify(raw));
  await assert.rejects(loadClientConfig(f.clientFile, {}), /local_only must be a boolean/);
});

test('dev runner handles stop during startup and removes its signal listeners', async () => {
  const signals = new EventEmitter(), logs = [];
  let service;
  assert.equal(await runDevelopment({ port: 0 }, { signals, json: true, logger: line => logs.push(JSON.parse(line)),
    start: async options => { signals.emit('SIGINT'); service = await startDevelopment(options); return service; } }), 0);
  assert.deepEqual(logs.map(event => event.state), ['stopped']);
  assert.equal(service.bridge.listening, false);
  await assert.rejects(fs.access(service.clientFile), { code: 'ENOENT' });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('dev runner reports safe failure reasons and never leaks raw startup/cleanup errors', async () => {
  for (const failure of ['startup', 'cleanup']) {
    const signals = new EventEmitter(), lines = [];
    await assert.rejects(runDevelopment({}, { signals, json: true, logger: line => {
      lines.push(line);
      if (JSON.parse(line).state === 'ready') signals.emit('SIGTERM');
    }, start: async () => {
      if (failure === 'startup') throw new Error('SECRET-STARTUP-ERROR');
      return { origin: 'http://127.0.0.1:1', clientFile: 'test-only', temporary: true,
        close: async () => { throw new Error('SECRET-CLEANUP-ERROR'); } };
    } }), /Development cleanup failed|Cannot start the local dev environment/);
    assert.equal(lines.join('\n').includes('SECRET-'), false);
    assert.equal(JSON.parse(lines.at(-1)).state, 'failed');
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
});

test('human dev commands safely quote config paths for POSIX and PowerShell', () => {
  const service = { origin: 'http://127.0.0.1:1', clientFile: "/tmp/dev' $(DO-NOT-RUN)/client.json", temporary: true };
  const posix = formatDevelopmentReady(service, 'darwin');
  const windows = formatDevelopmentReady(service, 'win32');
  assert.ok(posix.includes("--client-config '/tmp/dev'\"'\"' $(DO-NOT-RUN)/client.json'"));
  assert.ok(windows.includes("--client-config '/tmp/dev'' $(DO-NOT-RUN)/client.json'"));
  assert.equal(posix.includes(DEV_TOKEN), false);
});

test('CLI dev JSON startup, poison credential isolation and SIGTERM cleanup work locally', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const poison = 'DO-NOT-USE-ENV-CREDENTIAL'.padEnd(43, 'x');
  const child = spawn(process.execPath, [cli, 'dev', '--port', '0', '--json'], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HAI_BRIDGE_TOKEN: poison, HAI_UPSTREAM_API_KEY: poison } });
  let stdout = '', stderr = '', partial = '';
  const exit = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exit; });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error('dev exited before ready')));
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.state === 'ready') resolve(event);
      }
    });
  });
  assert.equal(ready.mock, true);
  const response = await fetch(ready.origin + '/openai/v1/models', { headers: { Authorization: 'Bearer ' + DEV_TOKEN } });
  const body = await response.json();
  assert.equal(body.mock, true);
  assert.equal(body.stats.rejectedAuth, 0);
  assert.equal(stdout.includes(poison), false);
  child.kill('SIGTERM');
  assert.equal(await exit, 0);
  assert.equal(stderr, '');
  assert.deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line).state), ['ready', 'stopped']);
  await assert.rejects(fs.access(ready.client_config), { code: 'ENOENT' });
});
