import { spawn } from 'node:child_process';
import { validatePort, validateSshTarget } from './config.mjs';

export function sshArguments(config) {
  const localPort = validatePort(config.localPort, 'local port');
  const remotePort = validatePort(config.remotePort, 'remote port');
  if (!['127.0.0.1', '::1'].includes(config.remoteHost)) throw new Error('SSH destination must be loopback');
  const remoteHost = config.remoteHost === '::1' ? '[::1]' : config.remoteHost;
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`];
  if (config.identityFile) args.push('-i', config.identityFile);
  args.push('--', validateSshTarget(config.target));
  return args;
}

export async function runTunnel(config, { logger = console.log, executable = 'ssh' } = {}) {
  const args = sshArguments(config);
  let child, stopping = false, timer, wake;
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    wake?.();
    child?.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (let failures = 0; !stopping; failures += 1) {
      logger(`SSH tunnel: 127.0.0.1:${config.localPort} → ${config.target} → ${config.remoteHost}:${config.remotePort}`);
      const code = await new Promise((resolve, reject) => {
        child = spawn(executable, args, { stdio: 'inherit', shell: false });
        child.once('error', () => reject(new Error('Cannot start SSH; install the OpenSSH client and check PATH')));
        child.once('exit', exitCode => resolve(exitCode ?? 1));
      });
      if (stopping) return 0;
      if (!config.reconnect || code === 0 || failures >= config.maxRetries) return code;
      const delay = Math.min(15000, 1000 * 2 ** failures);
      logger(`SSH exited (${code}); retry ${failures + 1}/${config.maxRetries} in ${delay / 1000}s`);
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, delay); });
      wake = undefined;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
