import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { validatePort, validateSshTarget, sshValue } from './config.mjs';

export function sshArguments(config) {
  const localPort = validatePort(config.localPort, 'local port');
  const remotePort = validatePort(config.remotePort, 'remote port');
  const direction = config.direction ?? 'local';
  if (!['local', 'remote'].includes(direction)) throw new Error('Invalid forwarding direction');
  if (!['127.0.0.1', '::1'].includes(config.remoteHost)) throw new Error('SSH destination must be loopback');
  if (direction === 'remote' && (config.remoteHost !== '127.0.0.1' || remotePort !== 22)) {
    throw new Error('Publisher may only forward Mac loopback SSH port 22');
  }
  const remoteHost = config.remoteHost === '::1' ? '[::1]' : config.remoteHost;
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ForwardAgent=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10'];
  if (config.sshConfigFile !== undefined) { sshValue(config.sshConfigFile); args.push('-F', config.sshConfigFile); }
  else if (direction === 'remote') args.push('-F', process.platform === 'win32' ? 'NUL' : '/dev/null');
  if (config.sshPort !== undefined) args.push('-p', String(validatePort(config.sshPort, 'ssh port')));
  if (config.knownHostsFile !== undefined) {
    args.push('-o', 'UserKnownHostsFile=' + sshValue(config.knownHostsFile), '-o', 'GlobalKnownHostsFile=none');
  }
  if (config.hostKeyAlias !== undefined) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(config.hostKeyAlias)) throw new Error('Invalid SSH host key alias');
    args.push('-o', 'HostKeyAlias=' + config.hostKeyAlias);
  }
  args.push(direction === 'remote' ? '-R' : '-L', '127.0.0.1:' + localPort + ':' + remoteHost + ':' + remotePort);
  if (config.identityFile !== undefined) { sshValue(config.identityFile); args.push('-i', config.identityFile); }
  args.push('--', validateSshTarget(config.target));
  return args;
}

export function classifySshFailure(stderr = '', code = 255) {
  if (/host key verification failed|remote host identification has changed|no .* host key is known/i.test(stderr)) return 'host_key';
  if (/permission denied|authentication failed|too many authentication failures|no such identity|sign_and_send_pubkey.*failed/i.test(stderr)) return 'authentication';
  if (/address already in use|cannot listen to port|remote port forwarding failed|cannot bind/i.test(stderr)) return 'forward_conflict';
  if (/administratively prohibited|forwarding disabled|forwarding.*not permitted/i.test(stderr)) return 'forward_denied';
  if (/bad configuration|bad owner|bad permissions|unknown option|unsupported option|bad .*option|cannot open.*config|can't open.*config/i.test(stderr)) return 'configuration';
  return code === 255 ? 'connection_failed' : 'ssh_exit';
}

export async function runTunnel(config, { logger = console.log, executable = 'ssh', spawnProcess = spawn,
  signals = process, pause = (ms, signal) => wait(ms, undefined, { signal }), now = () => performance.now() } = {}) {
  const args = sshArguments(config);
  const maxRetries = config.maxRetries ?? 5;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) throw new Error('Invalid maxRetries');
  const controller = new AbortController();
  let child, retries = 0;
  const stop = () => { controller.abort(); child?.kill('SIGTERM'); };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    while (!controller.signal.aborted) {
      const direction = config.direction === 'remote' ? 'publish' : 'connect';
      logger('Starting SSH ' + direction + ': ' + config.target + ' (loopback port ' + config.localPort + ')');
      const started = now();
      const result = await new Promise(resolve => {
        let stderr = '';
        try {
          child = spawnProcess(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
        } catch { resolve({ code: 1, reason: 'spawn_error' }); return; }
        // Keep a bounded diagnostic tail only. Do not log server banners or raw stderr.
        child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
        child.once('error', () => resolve({ code: 1, reason: 'spawn_error' }));
        child.once('close', code => {
          const exitCode = code ?? 255;
          resolve({ code: exitCode, reason: classifySshFailure(stderr, exitCode) });
        });
      });
      child = undefined;
      if (controller.signal.aborted) { logger('SSH stopped'); return 0; }
      if (result.code === 0) return 0;
      logger('SSH exited (' + result.code + '): ' + result.reason);
      if (result.reason === 'spawn_error') throw new Error('Cannot start SSH; install the OpenSSH client and check PATH');
      if (!config.reconnect || result.reason !== 'connection_failed') return result.code;
      // Reset only after a sustained process lifetime, not every brief reconnect.
      if (now() - started >= 30000) retries = 0;
      if (retries >= maxRetries) { logger('SSH retry budget exhausted'); return result.code; }
      const delay = Math.min(15000, 1000 * 2 ** retries);
      retries++;
      logger('Reconnect ' + retries + '/' + maxRetries + ' in ' + delay / 1000 + 's (requests are not replayed)');
      try { await pause(delay, controller.signal); }
      catch (error) { if (!controller.signal.aborted) throw error; }
    }
    return 0;
  } finally {
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
  }
}
