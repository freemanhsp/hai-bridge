import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { sshArguments, classifySshFailure } from '../../src/tunnel.mjs';
import { validatePort } from '../../src/config.mjs';
import { portFree } from './checks.mjs';

export function experimentalSshArguments({ direction, target, identity, knownHosts,
  relayPort = 18083, appPort = 18081, tunnelPort = 18085 }) {
  if (!['publish', 'connect'].includes(direction) || !identity || !knownHosts) throw new Error('Explicit SSH trust/identity required');
  validatePort(relayPort, 'relay port');
  validatePort(appPort, 'application port');
  validatePort(tunnelPort, 'tunnel port');
  const args = sshArguments({ direction: 'local', target, identityFile: path.resolve(identity),
    knownHostsFile: path.resolve(knownHosts), sshConfigFile: process.platform === 'win32' ? 'NUL' : '/dev/null',
    localPort: direction === 'publish' ? relayPort : tunnelPort,
    remoteHost: '127.0.0.1', remotePort: direction === 'publish' ? appPort : relayPort });
  // Separate experiment: existing production publisher keeps its Mac22-only guard intact.
  if (direction === 'publish') args[args.indexOf('-L')] = '-R';
  return args;
}

async function acceptsTcp(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = answer => { socket.destroy(); resolve(answer); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(300, () => done(false));
  });
}

// Only this object's child is stopped. No process lookup, existing tunnel takeover or hidden retries.
export function ownedSsh(options, { executable = 'ssh', spawnProcess = spawn } = {}) {
  const args = experimentalSshArguments(options);
  let child, exit, stderr = '', failure, running = false;
  return {
    get running() { return running; },
    get reason() { return failure; },
    async start() {
      if (child) return;
      if (options.direction === 'connect') await portFree(options.tunnelPort ?? 18085);
      stderr = ''; failure = undefined;
      child = spawnProcess(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      const current = child;
      exit = new Promise(resolve => {
        current.once('error', () => { failure = 'spawn_error'; running = false; resolve(); });
        current.once('close', code => { failure ||= classifySshFailure(stderr, code ?? 255); running = false; resolve(); });
      });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      running = true;
      try {
        if (options.direction === 'connect') {
          let ready = false;
          for (let attempt = 0; attempt < 100 && running; attempt++) {
            if (await acceptsTcp(options.tunnelPort ?? 18085)) { ready = true; break; }
            await pause(100);
          }
          if (!ready) throw new Error('Owned SSH tunnel unavailable');
        } else {
          await pause(500);
          if (!running) throw new Error('Owned SSH publisher unavailable');
          // A running SSH process is NOT proof of remote forwarding; B's TLS probe supplies that evidence.
        }
      } catch (error) { await this.stop(); throw error; }
    },
    async stop() {
      if (!child) return;
      const current = child;
      if (running) current.kill('SIGTERM');
      let timeout;
      const deadline = new Promise(resolve => { timeout = setTimeout(resolve, 3000); });
      await Promise.race([exit, deadline]);
      clearTimeout(timeout);
      if (running) {
        current.kill('SIGKILL');
        let lastTimeout;
        await Promise.race([exit, new Promise((resolve, reject) => {
          lastTimeout = setTimeout(() => reject(new Error('Owned SSH cleanup deadline')), 2000);
        })]).finally(() => clearTimeout(lastTimeout));
      }
      child = undefined;
      if (options.direction === 'connect') await portFree(options.tunnelPort ?? 18085);
    },
  };
}
