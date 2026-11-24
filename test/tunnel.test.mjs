import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sshArguments, runTunnel, classifySshFailure, sshFailureHint } from '../src/tunnel.mjs';
import { ownProcess } from '../src/owned-process.mjs';

test('SSH forwards only loopback and keeps default host-key verification', () => {
  const args = sshArguments({ localPort: 16655, remoteHost: '127.0.0.1', remotePort: 16656, target: 'user@mac.local' });
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:16655:127.0.0.1:16656');
  assert.equal(args.includes('ExitOnForwardFailure=yes'), true);
  assert.equal(args.includes('ServerAliveInterval=15'), true);
  assert.equal(args.some(arg => arg.includes('StrictHostKeyChecking=no')), false);
  assert.equal(args.at(-1), 'user@mac.local');
});

test('SSH arguments reject injected options and non-loopback destinations', () => {
  const config = { localPort: 16655, remoteHost: '127.0.0.1', remotePort: 16656, target: 'mac' };
  for (const target of ['-oProxyCommand=anything', 'user@host; command', 'user@host $(command)', '']) {
    assert.throws(() => sshArguments({ ...config, target }));
  }
  assert.throws(() => sshArguments({ ...config, remoteHost: '10.0.0.1' }));
  assert.throws(() => sshArguments({ ...config, localPort: 70000 }));
});

const CONFIG = { localPort: 18084, remoteHost: '127.0.0.1', remotePort: 18080,
  target: 'hai-bridge-mac', reconnect: true, maxRetries: 3 };

test('owned child stop is bounded, idempotent and does not signal an exited PID', { timeout: 1000 }, async () => {
  for (const alreadyExited of [false, true]) {
    const child = new EventEmitter(); child.pid = 999999; child.kills = [];
    child.kill = signal => { child.kills.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null)); return true; };
    const owner = ownProcess(child, { graceMs: 10, killMs: 10 });
    if (alreadyExited) { child.emit('exit', 0); setTimeout(() => child.emit('close', 0), 15); }
    await Promise.all([owner.stop(), owner.stop()]);
    assert.deepEqual(child.kills, alreadyExited ? [] : ['SIGTERM', 'SIGKILL']);
    assert.equal(owner.closed, true); assert.equal(child.listenerCount('error'), 0);
  }
  const child = new EventEmitter(); child.pid = 999999; const kills = [];
  child.kill = signal => { kills.push(signal); return true; };
  const owner = ownProcess(child, { graceMs: 5, killMs: 5 });
  await assert.rejects(owner.stop(), { code: 'SSH_STOP_TIMEOUT' });
  await assert.rejects(owner.stop(), { code: 'SSH_STOP_TIMEOUT' });
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  child.emit('error', new Error('SYNTHETIC-LATE')); child.emit('close', null);
});

test('observer exception during a live forward diagnostic cleans only its owned SSH', { timeout: 1000 }, async () => {
  const signals = new EventEmitter(), events = [], kills = [];
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999999;
  child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close', null)); return true; };
  await assert.rejects(runTunnel(CONFIG, { signals, logger: () => {}, forwardConfirmation: 'confirm',
    childStopOptions: { graceMs: 10, killMs: 10 }, onEvent(e) {
      events.push(e); if (e.state === 'forward_ready') throw new Error('SYNTHETIC-SECRET-OBSERVER');
    }, spawnProcess() { queueMicrotask(() => child.stderr.emit('data', Buffer.from('confirm\n'))); return child; } }), /observer/i);
  assert.deepEqual(kills, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(JSON.stringify(events).includes('SYNTHETIC-SECRET'), false);
});

test('unresponsive owned SSH on user stop escalates once and reports cleanup failure if still live', { timeout: 1000 }, async () => {
  for (const stuck of [false, true]) {
    const signals = new EventEmitter(), child = new EventEmitter(), kills = [], events = [];
    child.pid = 999999; child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (!stuck && signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null)); return true; };
    const task = runTunnel(CONFIG, { signals, logger: () => {}, childStopOptions: { graceMs: 10, killMs: 10 },
      onEvent: e => events.push(e), spawnProcess() { queueMicrotask(() => { signals.emit('SIGTERM'); signals.emit('SIGINT'); }); return child; } });
    if (stuck) await assert.rejects(task, { code: 'SSH_STOP_TIMEOUT' }); else assert.equal(await task, 0);
    assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    if (stuck) { assert.equal(events.some(e => e.state === 'stopped'), false); child.emit('close', null); }
  }
});

function harness(scenarios) {
  const signals = new EventEmitter(), logs = [], delays = [], children = [];
  let clock = 0;
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => { child.killedWith = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
    children.push({ child, executable, args, options });
    const scenario = scenarios[children.length - 1];
    assert.ok(scenario, 'unexpected spawn');
    queueMicrotask(() => {
      if (scenario.stop) { signals.emit('SIGINT'); return; }
      clock += scenario.duration ?? 1;
      if (scenario.stderr) child.stderr.emit('data', Buffer.from(scenario.stderr));
      for (const chunk of scenario.chunks ?? []) child.stderr.emit('data', Buffer.from(chunk));
      child.emit('close', scenario.code ?? 255);
    });
    return child;
  };
  return { signals, logs, delays, children, spawnProcess,
    dependencies: { signals, spawnProcess, logger: message => logs.push(message), now: () => clock,
      pause: async ms => { delays.push(ms); } } };
}

test('async observer rejection and close racing together cannot hide failure or start a retry', { timeout: 1000 }, async () => {
  const h = harness([{ code: 255, stderr: 'confirm\n' }]);
  await assert.rejects(runTunnel(CONFIG, { ...h.dependencies, forwardConfirmation: 'confirm',
    onEvent: async event => { if (event.state === 'forward_ready') { await Promise.resolve(); throw new Error('SYNTHETIC-SECRET'); } } }),
  error => error.code === 'OBSERVER_ERROR' && !error.message.includes('SYNTHETIC-SECRET'));
  assert.equal(h.children.length, 1); assert.equal(h.delays.length, 0);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
});

test('logger and starting/retry observer exceptions never leave handlers or launch extra children', { timeout: 1000 }, async () => {
  for (const stage of ['logger', 'starting', 'retry_wait']) {
    const h = harness([{}]);
    await assert.rejects(runTunnel(CONFIG, { ...h.dependencies,
      logger: stage === 'logger' ? () => { throw new Error('SYNTHETIC-SECRET'); } : () => {},
      onEvent: event => { if (event.state === stage) throw new Error('SYNTHETIC-SECRET'); },
    }), { code: 'OBSERVER_ERROR' });
    assert.equal(h.children.length, stage === 'retry_wait' ? 1 : 0);
    assert.equal(h.signals.listenerCount('SIGINT'), 0); assert.equal(h.delays.length, 0);
  }
});

test('spawn error before close and live-child error both drain only owned child without retry', { timeout: 1000 }, async () => {
  for (const spawned of [false, true]) {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); const kills = [];
    if (spawned) child.pid = 999999;
    child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close', 1)); return true; };
    const signals = new EventEmitter();
    await assert.rejects(runTunnel(CONFIG, { signals, logger: () => {}, childStopOptions: { graceMs: 10, killMs: 10 },
      spawnProcess() { queueMicrotask(() => {
        child.emit('error', new Error('SYNTHETIC-SECRET'));
        if (!spawned) queueMicrotask(() => child.emit('close', 1));
      }); return child; } }), /Cannot start SSH/);
    assert.deepEqual(kills, spawned ? ['SIGTERM'] : []);
    assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(child.listenerCount('error'), 0);
  }
});

test('a closed old attempt and delayed diagnostics cannot affect its successor or be signalled again', { timeout: 1000 }, async () => {
  const h = harness([{}, { stop: true }]);
  const original = h.dependencies.spawnProcess;
  h.dependencies.spawnProcess = (...args) => {
    const child = original(...args);
    if (h.children.length === 2) {
      const old = h.children[0].child;
      assert.equal(old.listenerCount('close'), 0); assert.equal(old.stderr.listenerCount('data'), 0);
      old.stderr.emit('data', Buffer.from('confirm\n')); old.emit('close', 0);
    }
    return child;
  };
  const events = [];
  assert.equal(await runTunnel(CONFIG, { ...h.dependencies, forwardConfirmation: 'confirm', onEvent: e => events.push(e) }), 0);
  assert.equal(h.children[0].child.killedWith, undefined); assert.equal(h.children[1].child.killedWith, 'SIGTERM');
  assert.equal(events.some(e => e.state === 'forward_ready'), false);
});

test('publisher args allow only loopback SSH and preserve pinned/configured identities', () => {
  const config = { ...CONFIG, direction: 'remote', remotePort: 22, identityFile: '/tmp/key with spaces',
    knownHostsFile: '/tmp/hosts with spaces', sshPort: 2222, hostKeyAlias: 'pinned-relay', sshConfigFile: '/tmp/profile' };
  const args = sshArguments(config);
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:18084:127.0.0.1:22');
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.equal(args[args.indexOf('-F') + 1], '/tmp/profile');
  const isolated = sshArguments({ ...config, sshConfigFile: undefined });
  assert.equal(isolated[isolated.indexOf('-F') + 1], process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.ok(args.includes('UserKnownHostsFile="/tmp/hosts with spaces"'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.throws(() => sshArguments({ ...config, remotePort: 6655 }), /only forward/);
  assert.throws(() => sshArguments({ ...config, remoteHost: '::1' }), /only forward/);
  assert.throws(() => sshArguments({ ...config, direction: 'other' }));
  assert.throws(() => sshArguments({ ...config, sshConfigFile: 'bad\nprofile' }));
  assert.throws(() => sshArguments({ ...config, sshPort: 0 }));
});

test('network exits retry with bounded exponential backoff and no shell', async () => {
  const h = harness([{}, {}, {}, {}]);
  assert.equal(await runTunnel(CONFIG, h.dependencies), 255);
  assert.deepEqual(h.delays, [1000, 2000, 4000]);
  assert.equal(h.children.length, 4);
  assert.equal(h.children[0].options.shell, false);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
  assert.ok(h.logs.some(message => message.includes('retry budget exhausted')));
});

test('authentication, host-key, forwarding and configuration errors stop without retry or raw logs', async () => {
  for (const stderr of ['Permission denied (publickey).', 'REMOTE HOST IDENTIFICATION HAS CHANGED!',
    'bind: Address already in use', 'remote port forwarding failed for listen port 18083',
    'channel 0: open failed: administratively prohibited', "Can't open user config file: missing"]) {
    const h = harness([{ stderr: stderr + '\nSECRET-DIAGNOSTIC' }]);
    assert.equal(await runTunnel(CONFIG, h.dependencies), 255);
    assert.deepEqual(h.delays, []);
    assert.equal(h.logs.join('\n').includes('SECRET-DIAGNOSTIC'), false);
    assert.notEqual(classifySshFailure(stderr), 'connection_failed');
  }
});

test('Ctrl-C stops only its own SSH child and removes signal handlers', async () => {
  const h = harness([{ stop: true }]);
  assert.equal(await runTunnel(CONFIG, h.dependencies), 0);
  assert.equal(h.children[0].child.killedWith, 'SIGTERM');
  assert.equal(h.children.length, 1);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
});

test('Ctrl-C aborts retry wait without spawning another SSH process', async () => {
  const h = harness([{}]);
  h.dependencies.pause = async (ms, signal) => {
    h.delays.push(ms);
    h.signals.emit('SIGINT');
    assert.equal(signal.aborted, true);
    throw new Error('aborted');
  };
  assert.equal(await runTunnel(CONFIG, h.dependencies), 0);
  assert.equal(h.children.length, 1);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
});

test('sustained SSH process resets consecutive failure budget but brief reconnects do not', async () => {
  const h = harness([{ duration: 1 }, { duration: 30000 }, { duration: 1 }]);
  assert.equal(await runTunnel({ ...CONFIG, maxRetries: 1 }, h.dependencies), 255);
  assert.deepEqual(h.delays, [1000, 1000]);
  assert.equal(h.children.length, 3);
});

test('spawn failure is safe and nonzero exits without reconnect terminate immediately', async () => {
  const h = harness([]);
  await assert.rejects(runTunnel(CONFIG, { ...h.dependencies, spawnProcess: () => { throw new Error('SECRET'); } }), /Cannot start SSH/);
  assert.equal(h.logs.join('\n').includes('SECRET'), false);
  const disabled = harness([{}]);
  assert.equal(await runTunnel({ ...CONFIG, reconnect: false }, disabled.dependencies), 255);
  assert.deepEqual(disabled.delays, []);
  const success = harness([{ code: 0 }]);
  assert.equal(await runTunnel(CONFIG, success.dependencies), 0);
  assert.deepEqual(success.delays, []);
});

test('structured transport events describe attempts and retry waits without claiming readiness', async () => {
  const h = harness([{}, { code: 0 }]), events = [];
  assert.equal(await runTunnel(CONFIG, { ...h.dependencies, onEvent: event => events.push(event) }), 0);
  assert.deepEqual(events.map(event => event.state), ['starting', 'exited', 'retry_wait', 'starting', 'stopped']);
  assert.equal(events[2].delay_ms, 1000);
  assert.equal(events[2].retry, 1);
  assert.equal(events[2].requests_replayed, false);
  assert.equal(events[3].attempt, 2);
  assert.ok(events.every(event => event.event === 'ssh' && event.direction === 'connect'));
  assert.equal(events.some(event => ['connected', 'ready'].includes(event.state)), false);
});

test('fatal and exhausted events expose safe reasons and actionable hints, never stderr', async () => {
  for (const scenario of [{ stderr: 'Permission denied (publickey). SECRET-STDERR' }, { stderr: 'Connection refused SECRET-STDERR' }]) {
    const h = harness([scenario]), events = [];
    assert.equal(await runTunnel({ ...CONFIG, maxRetries: 0 }, { ...h.dependencies, onEvent: event => events.push(event) }), 255);
    const final = events.at(-1);
    assert.equal(final.state, scenario.stderr.startsWith('Permission') ? 'failed' : 'retry_exhausted');
    assert.ok(final.hint.length > 20);
    assert.equal((JSON.stringify(events) + h.logs.join('\n')).includes('SECRET-STDERR'), false);
  }
  for (const reason of ['host_key', 'authentication', 'forward_conflict', 'forward_denied', 'configuration', 'connection_failed', 'spawn_error', 'ssh_exit']) {
    assert.ok(sshFailureHint(reason).length > 20);
  }
  const h = harness([]), events = [];
  await assert.rejects(runTunnel(CONFIG, { ...h.dependencies, onEvent: event => events.push(event),
    spawnProcess: () => { throw new Error('SECRET-SPAWN-ERROR'); } }), /Cannot start SSH/);
  assert.deepEqual(events.map(event => event.state), ['starting', 'failed']);
  assert.equal(JSON.stringify(events).includes('SECRET-SPAWN-ERROR'), false);
});

test('forward confirmation requires a complete exact line, resets per attempt and never exports stderr', async () => {
  const forwardConfirmation = 'debug1: remote forward success for: listen 127.0.0.1:18083, connect 127.0.0.1:18081';
  const h = harness([{ chunks: ['PRIVATE-DIAGNOSTIC\n', forwardConfirmation.slice(0, 42),
    forwardConfirmation.slice(42), '\r\n', forwardConfirmation + '\n'] },
  { code: 0, stderr: forwardConfirmation + '\n' }]), events = [];
  assert.equal(await runTunnel(CONFIG, { ...h.dependencies, forwardConfirmation, onEvent: e => events.push(e) }), 0);
  const ready = events.filter(e => e.state === 'forward_ready');
  assert.deepEqual(ready.map(e => e.attempt), [1, 2]);
  assert.ok(ready.every(e => e.end_to_end === 'not_checked' && e.forward_scope === 'relay_listener'));
  assert.equal((JSON.stringify(events) + h.logs.join('')).includes('PRIVATE-DIAGNOSTIC'), false);
  for (const stderr of [forwardConfirmation, forwardConfirmation.replace('18081', '18082') + '\n',
    'banner ' + forwardConfirmation + '\n', 'remote port forwarding failed for listen port 18083\n', '']) {
    const missing = harness([{ code: 0, stderr }]), output = [];
    await runTunnel(CONFIG, { ...missing.dependencies, forwardConfirmation, onEvent: e => output.push(e) });
    assert.equal(output.some(e => e.state === 'forward_ready'), false);
  }
});

test('forward diagnostic after cancellation or child exit cannot report readiness', async () => {
  for (const end of ['cancel', 'close']) {
    const signals = new EventEmitter(), events = [];
    await runTunnel(CONFIG, { signals, logger: () => {}, forwardConfirmation: 'confirmation',
      onEvent: e => events.push(e), spawnProcess() {
        const child = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { child.emit('close', null); return true; };
        queueMicrotask(() => {
          if (end === 'cancel') signals.emit('SIGINT'); else child.emit('close', 0);
          child.stderr.emit('data', Buffer.from('confirmation\n'));
        });
        return child;
      } });
    assert.equal(events.some(e => e.state === 'forward_ready'), false);
  }
});

test('cancellation emits exactly one stopped event and never schedules another attempt', async () => {
  const h = harness([{}]), events = [];
  h.dependencies.pause = async () => { h.signals.emit('SIGTERM'); throw new Error('aborted'); };
  assert.equal(await runTunnel(CONFIG, { ...h.dependencies, onEvent: event => events.push(event) }), 0);
  assert.deepEqual(events.map(event => event.state), ['starting', 'exited', 'retry_wait', 'stopped']);
  assert.equal(events.at(-1).reason, 'user_stop');
  assert.equal(h.children.length, 1);
});

test('CLI JSON mode emits only safe events using a local SSH stub, not a real connection', { skip: process.platform === 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-json-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'ssh'), '#!/usr/bin/env node\nprocess.stderr.write("Permission denied (publickey). SECRET-STUB-STDERR");\nprocess.exit(255);\n', { mode: 0o700 });
  const file = path.join(dir, 'publisher.json');
  await fs.writeFile(file, JSON.stringify({ ssh_target: 'publisher@relay.example.invalid', relay_port: 18083,
    reconnect: true, max_retries: 0 }), { mode: 0o600 });
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, [path.resolve('bin/hai-bridge.mjs'), 'publish', '--publisher-config', file, '--json'], {
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
  }), error => {
    assert.equal(error.code, 255);
    const events = error.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.state), ['starting', 'exited', 'failed']);
    assert.equal(events.at(-1).reason, 'authentication');
    assert.equal(error.stderr, '');
    assert.equal(error.stdout.includes('SECRET-STUB-STDERR'), false);
    return true;
  });
});
