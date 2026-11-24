import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { validatePort, validateSshTarget, sshValue } from './config.mjs';
import { ownProcess, validateProcessStopOptions } from './owned-process.mjs';

export function observerFailure() {
  return Object.assign(new Error('Lifecycle observer failed; diagnostic contents were withheld'), { code: 'OBSERVER_ERROR' });
}
export async function observe(callback, ...args) {
  try { return await callback?.(...args); } catch { throw observerFailure(); }
}

export function sshArguments(config) {
  if (config.localOnly) throw new Error('Local-only development configuration cannot establish SSH forwarding');
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

export function sshFailureHint(reason) {
  const hints = {
    host_key: 'Verify the expected fingerprint through a trusted channel and check known_hosts/HostKeyAlias. Do not disable verification or remove entries just to connect.',
    authentication: 'Check the authorized public key, identity path/permissions and SSH agent for each hop. Confirm BatchMode public-key login separately; never share private keys.',
    forward_conflict: 'Check the local/relay port for an old tunnel, and check remote forwarding policy. Stop only your own obsolete tunnel; no other listener is killed automatically.',
    forward_denied: 'Confirm the permitted forwarding direction and PermitOpen/PermitListen with the administrator. Do not loosen VPN or security policies to reconnect.',
    configuration: 'Check the dedicated SSH profile syntax, file access and supported OpenSSH options; global SSH config is not repaired automatically.',
    connection_failed: 'Check network reachability and whether publisher/connect are still running. Restoring transport does not replay model requests.',
    spawn_error: 'Install OpenSSH Client and confirm ssh -V works in this terminal.',
    ssh_exit: 'Review this SSH exit manually; only connection failures qualify for automatic retry.',
  };
  return hints[reason] || hints.ssh_exit;
}

export async function runTunnel(config, { logger = console.log, onEvent, executable = 'ssh', spawnProcess = spawn,
  signals = process, pause = (ms, signal) => wait(ms, undefined, { signal }), now = () => performance.now(),
  buildArgs = sshArguments, forwardConfirmation, childStopOptions } = {}) {
  const stopOptions = validateProcessStopOptions(childStopOptions); // Reject before creating a child.
  const args = buildArgs(config);
  const maxRetries = config.maxRetries ?? 5;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) throw new Error('Invalid maxRetries');
  const controller = new AbortController();
  let owner, retries = 0, attempt = 0;
  let resolveFault;
  const fault = new Promise(resolve => { resolveFault = resolve; });
  const direction = config.direction === 'remote' ? 'publish' : 'connect';
  const emit = (state, details = {}) => observe(onEvent, { event: 'ssh', state, direction,
    loopback_port: config.localPort, attempt, ...details });
  const log = message => observe(logger, message);
  const stopped = async () => { await emit('stopped', { reason: 'user_stop', exit_code: 0 }); await log('SSH stopped'); return 0; };
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    owner?.stop().catch(error => resolveFault({ error }));
  };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    while (!controller.signal.aborted) {
      attempt++;
      await emit('starting');
      if (controller.signal.aborted) return await stopped();
      await log('Starting SSH ' + direction + ': ' + config.target + ' (loopback port ' + config.localPort + ')');
      if (controller.signal.aborted) return await stopped();
      const started = now();
      let result, child, stderr = '', forwardConfirmed = false, finished = false, observerError;
      const observations = [];
      try {
        child = spawnProcess(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      } catch { result = { code: 1, reason: 'spawn_error' }; }
      if (child) {
        owner = ownProcess(child, stopOptions);
        // Keep a bounded diagnostic tail only. Do not log server banners or raw stderr.
        const onData = chunk => {
          try {
            stderr = (stderr + chunk.toString()).slice(-16384);
            // Best-effort OpenSSH diagnostic, not a security check or end-to-end probe.
            // Require the exact expected forwarding tuple and a complete line.
            if (forwardConfirmation && !forwardConfirmed && !finished && owner.live() && !controller.signal.aborted
                && stderr.split(/\r?\n/).slice(0, -1).includes(forwardConfirmation)) {
              forwardConfirmed = true;
              observations.push(emit('forward_ready', { forward_scope: 'relay_listener', end_to_end: 'not_checked' })
                .catch(error => { observerError = error; resolveFault({ error }); }));
            }
          } catch { resolveFault({ error: observerFailure() }); }
        };
        child.stderr?.on('data', onData);
        try {
          if (controller.signal.aborted) owner.stop().catch(error => resolveFault({ error }));
          result = await Promise.race([owner.result, fault]);
          if (result.error) throw result.error;
          await Promise.all(observations);
          if (observerError) throw observerError;
          result.reason ??= classifySshFailure(stderr, result.code);
        } finally {
          finished = true;
          child.stderr?.removeListener('data', onData);
          await owner.stop();
          owner = undefined;
        }
      }
      if (controller.signal.aborted) return await stopped();
      if (result.code === 0) {
        await emit('stopped', { reason: 'ssh_exit', exit_code: 0 });
        await log('SSH exited cleanly; the tunnel is no longer running');
        return 0;
      }
      if (result.reason !== 'spawn_error') {
        await emit('exited', { exit_code: result.code, reason: result.reason });
        await log('SSH exited (' + result.code + '): ' + result.reason);
      } else await log('Cannot start SSH: spawn_error');
      const fail = async state => {
        const hint = sshFailureHint(result.reason);
        await emit(state, { exit_code: result.code, reason: result.reason, hint });
        await log('Next: ' + hint);
        return result.code;
      };
      if (result.reason === 'spawn_error') {
        await fail('failed');
        throw new Error('Cannot start SSH; install the OpenSSH client and check PATH');
      }
      if (!config.reconnect || result.reason !== 'connection_failed') return await fail('failed');
      // Reset only after a sustained process lifetime, not every brief reconnect.
      if (now() - started >= 30000) retries = 0;
      if (retries >= maxRetries) { await log('SSH retry budget exhausted'); return await fail('retry_exhausted'); }
      const delay = Math.min(15000, 1000 * 2 ** retries);
      retries++;
      await emit('retry_wait', { retry: retries, max_retries: maxRetries, delay_ms: delay, requests_replayed: false });
      await log('Reconnect ' + retries + '/' + maxRetries + ' in ' + delay / 1000 + 's (requests are not replayed)');
      try {
        const result = await Promise.race([pause(delay, controller.signal), fault]);
        if (result?.error) throw result.error;
      }
      catch (error) { if (!controller.signal.aborted) throw error; }
    }
    return await stopped();
  } catch (error) {
    if (['SSH_STOP_TIMEOUT', 'OBSERVER_ERROR'].includes(error.code)) {
      await emit('failed', { reason: error.code, exit_code: 1, owned_ssh: error.code === 'SSH_STOP_TIMEOUT' ? 'not_confirmed' : 'stopped_or_not_started',
        remote_release: 'not_checked' }).catch(() => {});
    }
    throw error;
  } finally {
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
    await owner?.stop();
  }
}
