import test from 'node:test';
import assert from 'node:assert/strict';
import { sshArguments } from '../src/tunnel.mjs';

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
