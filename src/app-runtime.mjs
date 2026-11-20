import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { sshArguments, runTunnel } from './tunnel.mjs';
import { applicationPort, APPLICATION_TRANSPORT } from './app-config.mjs';
import { startMockPublisher, startMockClient, startHaiPublisher, startHaiClient } from './app-transport.mjs';

export function applicationSshArguments(config) {
  if (config.transport !== APPLICATION_TRANSPORT || !['mock', 'hai'].includes(config.mode)
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
  if (config.role === 'publisher') args[args.indexOf('-L')] = '-R';
  return args;
}

export async function assertPortFree(port) {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise(resolve => server.close(resolve));
}

export async function runApplication(config, { signals = process, onEvent = () => {}, onListening,
  spawnProcess = spawn, executable = 'ssh', pause, now,
  startPublisher = config.mode === 'hai' ? startHaiPublisher : startMockPublisher,
  startClient = config.mode === 'hai' ? startHaiClient : startMockClient } = {}) {
  applicationSshArguments(config); // Reject transport downgrade before binding or spawning.
  const ownedSignals = new EventEmitter();
  let service, child, stopping = false, forceTimer;
  const emit = (state, details = {}) => onEvent({ event: 'application', transport: APPLICATION_TRANSPORT,
    role: config.role, state, mock: config.mode === 'mock', hai: config.mode === 'mock' ? 'not_called' : 'enabled', ...details });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    ownedSignals.emit('SIGTERM');
    // A bounded escalation applies exclusively to the process created by this invocation.
    if (child) { const ownChild = child; forceTimer = setTimeout(() => ownChild.kill('SIGKILL'), 2000); forceTimer.unref?.(); }
  };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  try {
    if (config.role === 'client') await assertPortFree(config.tunnelPort);
    if (stopping) return 0;
    service = config.role === 'publisher' ? await startPublisher(config.pair, { port: config.appPort, config })
      : await startClient(config.pair, { port: config.localPort, tlsPort: config.tunnelPort, token: config.token });
    if (stopping) return 0;
    emit('listening', { loopback_port: service.port, end_to_end: 'not_checked' });
    onListening?.(service);
    if (stopping) return 0;
    const code = await runTunnel({ ...config, direction: config.role === 'publisher' ? 'remote' : 'local',
      localPort: config.role === 'publisher' ? config.relayPort : config.tunnelPort }, {
      signals: ownedSignals, buildArgs: applicationSshArguments, executable,
      spawnProcess(command, args, options) {
        child = spawnProcess(command, args, options);
        const current = child;
        current.once('close', () => { if (child === current) child = undefined; });
        return current;
      }, logger: () => {}, onEvent: event => onEvent({ ...event, transport: APPLICATION_TRANSPORT }),
      ...(pause ? { pause } : {}), ...(now ? { now } : {}),
    });
    return code;
  } catch (error) {
    emit('failed', { reason: ['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'startup_error' });
    const failure = new Error(error.code === 'EADDRINUSE'
      ? 'Application port is already in use; stop your previous owned instance or keep using it. No existing process was stopped.'
      : 'Application startup failed; check isolated pairing, file permissions, loopback ports and OpenSSH');
    failure.code = error.code;
    throw failure;
  } finally {
    clearTimeout(forceTimer);
    await service?.close();
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
    emit('stopped', { reason: stopping ? 'user_stop' : 'transport_exit' });
  }
}
