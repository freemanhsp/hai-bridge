import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { sshArguments, runTunnel, observe } from './tunnel.mjs';
import { applicationPort, APPLICATION_TRANSPORT } from './app-config.mjs';
import { startMockPublisher, startMockClient, startHaiPublisher, startHaiClient } from './app-transport.mjs';
import { DEVICE_TRANSPORT } from './device-identity.mjs';
import { startDevicePublisher, startDeviceClient } from './device-transport.mjs';

export function applicationSshArguments(config) {
  if (![APPLICATION_TRANSPORT, DEVICE_TRANSPORT].includes(config.transport) || !['mock', 'hai'].includes(config.mode)
      || !['publisher', 'client'].includes(config.role) || !config.identityFile || !config.knownHostsFile) {
    throw new Error('Only explicit versioned application SSH configurations are accepted');
  }
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9.:[\]-]+$/.test(config.target) || config.target.startsWith('root@')) throw new Error('Application SSH requires a non-root ECS user');
  const relayPort = applicationPort(config.relayPort, 'relay port');
  const endpointPort = applicationPort(config.role === 'publisher' ? config.appPort : config.tunnelPort, 'application port');
  const args = sshArguments({ target: config.target, direction: 'local',
    localPort: config.role === 'publisher' ? relayPort : endpointPort,
    remotePort: config.role === 'publisher' ? endpointPort : relayPort, remoteHost: '127.0.0.1',
    sshPort: config.sshPort, identityFile: config.identityFile, knownHostsFile: config.knownHostsFile,
    sshConfigFile: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  if (config.role === 'publisher') {
    args[args.indexOf('-L')] = '-R';
    // Capture forwarding confirmation privately; verbose output is never printed.
    args.unshift('-v');
  }
  return args;
}

export async function assertPortFree(port) {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise(resolve => server.close(resolve));
}

export async function runApplication(config, { signals = process, onEvent = () => {}, onListening,
  spawnProcess = spawn, executable = 'ssh', pause, now, childStopOptions,
  startPublisher = config.transport === DEVICE_TRANSPORT ? startDevicePublisher : config.mode === 'hai' ? startHaiPublisher : startMockPublisher,
  startClient = config.transport === DEVICE_TRANSPORT ? startDeviceClient : config.mode === 'hai' ? startHaiClient : startMockClient } = {}) {
  applicationSshArguments(config); // Reject transport downgrade before binding or spawning.
  const ownedSignals = new EventEmitter();
  let service, stopping = false, failureCode;
  const emit = (state, details = {}) => observe(onEvent, { event: 'application', transport: config.transport,
    role: config.role, state, mock: config.mode === 'mock', hai: config.mode === 'mock' ? 'not_called' : 'enabled', ...details });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    ownedSignals.emit('SIGTERM');
  };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  try {
    if (config.role === 'client') await assertPortFree(config.tunnelPort);
    if (stopping) return 0;
    service = config.role === 'publisher' ? await startPublisher(config.pair, { port: config.appPort, config,
      logger(event) {
        if (['device_tls', 'device_auth'].includes(event.event)) void observe(onEvent, { ...event, transport: config.transport, role: config.role }).catch(() => {});
      } })
      : await startClient(config.pair, { port: config.localPort, tlsPort: config.tunnelPort, token: config.token, config });
    if (stopping) return 0;
    await emit('listening', { loopback_port: service.port, end_to_end: 'not_checked' });
    await observe(onListening, service);
    if (stopping) return 0;
    const code = await runTunnel({ ...config, direction: config.role === 'publisher' ? 'remote' : 'local',
      localPort: config.role === 'publisher' ? config.relayPort : config.tunnelPort }, {
      signals: ownedSignals, buildArgs: applicationSshArguments, executable,
      spawnProcess, childStopOptions, logger: () => {}, onEvent: event => onEvent({ ...event, transport: config.transport }),
      ...(config.role === 'publisher' ? { forwardConfirmation:
        'debug1: remote forward success for: listen 127.0.0.1:' + config.relayPort
        + ', connect 127.0.0.1:' + config.appPort } : {}),
      ...(pause ? { pause } : {}), ...(now ? { now } : {}),
    });
    return code;
  } catch (error) {
    failureCode = error.code;
    await emit('failed', { reason: ['EADDRINUSE', 'EACCES', 'EPERM', 'SSH_STOP_TIMEOUT', 'OBSERVER_ERROR'].includes(error.code) ? error.code : 'startup_error' }).catch(() => {});
    const failure = new Error(error.code === 'SSH_STOP_TIMEOUT'
      ? 'Owned SSH cleanup timed out; local service will close, but SSH and remote release are not confirmed. No foreign process was stopped.'
      : error.code === 'OBSERVER_ERROR' ? 'Application lifecycle observer failed; diagnostic contents were withheld'
      : error.code === 'EADDRINUSE'
      ? 'Application port is already in use; stop your previous owned instance or keep using it. No existing process was stopped.'
      : 'Application startup failed; check isolated pairing, file permissions, loopback ports and OpenSSH');
    failure.code = error.code;
    throw failure;
  } finally {
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
    try { await service?.close(); }
    catch {
      await emit('cleanup_failed', { reason: 'local_close_error', local_service: 'not_confirmed',
        owned_ssh: 'not_checked', remote_release: 'not_checked' }).catch(() => {});
      throw Object.assign(new Error('Local service cleanup failed; no foreign process was stopped'), { code: 'LOCAL_STOP_ERROR' });
    }
    await emit(failureCode === 'SSH_STOP_TIMEOUT' ? 'cleanup_failed' : 'stopped', {
      reason: failureCode === 'SSH_STOP_TIMEOUT' ? 'SSH_STOP_TIMEOUT' : stopping ? 'user_stop' : 'transport_exit',
      local_service: service ? 'stopped' : 'not_started', owned_ssh: failureCode === 'SSH_STOP_TIMEOUT' ? 'not_confirmed' : 'stopped_or_not_started',
      remote_release: 'not_checked' }).catch(error => { if (!failureCode) throw error; });
  }
}
