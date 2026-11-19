import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sshArguments, runTunnel, classifySshFailure } from '../src/tunnel.mjs';

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
      child.emit('close', scenario.code ?? 255);
    });
    return child;
  };
  return { signals, logs, delays, children, spawnProcess,
    dependencies: { signals, spawnProcess, logger: message => logs.push(message), now: () => clock,
      pause: async ms => { delays.push(ms); } } };
}

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
