#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { initializeServer, loadServerConfig, loadClientConfig, exportClient, credentialReaders,
  DEFAULT_CLIENT_CONFIG, DEFAULT_SERVER_CONFIG } from '../src/config.mjs';
import { createBridge } from '../src/bridge.mjs';
import { runTunnel } from '../src/tunnel.mjs';
import { initializePublisher, loadPublisherConfig, initializeRelayClient,
  DEFAULT_PUBLISHER_CONFIG } from '../src/relay-config.mjs';
import { clientOrigin, diagnose, probeInference, runCodex } from '../src/client.mjs';
import { diagnoseOffline, formatOfflineReport } from '../src/preflight.mjs';
import { runDevelopment } from '../src/dev.mjs';
import { PACKAGE_NAME, VERSION, versionInfo } from '../src/version.mjs';
import { runLifecycleChecks } from '../src/lifecycle.mjs';
import { initializeApplicationPublisher, initializeApplicationClient, loadApplicationConfig, loadToolClient,
  DEFAULT_APP_SERVER_ROOT, DEFAULT_APP_CLIENT_CONFIG, APPLICATION_TRANSPORT } from '../src/app-config.mjs';
import { runApplication } from '../src/app-runtime.mjs';
import { checkApplicationClient } from '../src/app-checks.mjs';

const HELP = `HAI Bridge MVP — Node.js 22+

  version      [--json] (also --version / -v)
  init-app     --mock --ssh-target USER@ECS --identity-file PATH --known-hosts-file PATH
               [--out DIRECTORY] [--app-port PORT] [--relay-port PORT] [--ssh-port PORT] [--max-retries N]
  init-app-client --mock --pairing-dir DIRECTORY --ssh-target USER@ECS --identity-file PATH --known-hosts-file PATH
                  [--out PATH] [--local-port PORT] [--tunnel-port PORT] [--relay-port PORT] [--ssh-port PORT] [--max-retries N]
  publish-app  --server-config PATH [--json]
  connect-app  [--client-config PATH] [--json]
  check-app    --client-config PATH --out PATH [--interrupt-ssh] [--json]
  init-server  [--server-config PATH] [--upstream-url URL] [--upstream-auth-file PATH]
  pair         --ssh-target USER@MAC [--out PATH] [--local-port PORT] [--model MODEL]
  serve        [--server-config PATH]
  connect      [--client-config PATH] [--json]
  init-publisher --ssh-target USER@ECS [--identity-file PATH] [--known-hosts-file PATH]
                 [--publisher-config PATH] [--ssh-port PORT] [--relay-port PORT]
  publish      [--publisher-config PATH] [--json]
  init-relay-client --relay-target USER@ECS --mac-user USER --relay-identity-file PATH
                    --identity-file PATH (--mock | --pairing-file PATH) [--out PATH]
                    [--known-hosts-file PATH] [--ssh-port PORT] [--relay-port PORT] [--local-port PORT]
  doctor       [--client-config PATH] [--base-url URL]
  doctor       --offline [--client-config PATH | --publisher-config PATH] [--json]
  dev          [--port PORT] [--out PATH] [--json]
  check-lifecycle --client-config PATH --out PATH [--interrupt-ssh] [--json]
  probe        [--client-config PATH] [--base-url URL] [--infer] [--model MODEL]
  codex        [--client-config PATH] [--base-url URL] -- [CODEX ARGS...]

Default server config: .local/server.json
Default client config: .local/client.json
Default publisher config: .local/publisher.json
Default configuration paths are relative to your current working directory, not the install directory.
publish/connect run in foreground; Ctrl-C stops only their own SSH child.
Credentials are not printed. 'probe --infer' is billable with a real upstream; dev is synthetic.
Offline doctor never connects to SSH/HAI or changes trust; it briefly checks local port binding.
dev starts only local mock services (default port 18090); config is temporary unless --out is set.
check-lifecycle is MOCK ONLY and owns its SSH; --interrupt-ssh intentionally stops that child to test recovery.
Application TLS commands are MOCK ONLY; A/B use outbound ECS SSH, never Mac system login.
Application init needs OpenSSL on A only. B imports a private short-lived TLS pairing; HAI is not read.
`;

async function main() {
  const raw = process.argv.slice(2);
  const command = raw.shift();
  if (['version', '--version', '-v'].includes(command)) {
    const { values } = parseArgs({ args: raw, options: { json: { type: 'boolean' } } });
    console.log(values.json ? JSON.stringify(versionInfo()) : PACKAGE_NAME + ' ' + VERSION);
    return;
  }
  const separator = raw.indexOf('--');
  const userArgs = separator === -1 ? [] : raw.slice(separator + 1);
  const options = separator === -1 ? raw : raw.slice(0, separator);
  const { values, positionals } = parseArgs({ args: options, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, infer: { type: 'boolean' }, mock: { type: 'boolean' },
    offline: { type: 'boolean' }, json: { type: 'boolean' }, port: { type: 'string' },
    'interrupt-ssh': { type: 'boolean' },
    'server-config': { type: 'string' }, 'client-config': { type: 'string' },
    'upstream-url': { type: 'string' }, 'upstream-auth-file': { type: 'string' },
    'ssh-target': { type: 'string' }, 'local-port': { type: 'string' },
    out: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
    'publisher-config': { type: 'string' }, 'relay-target': { type: 'string' }, 'mac-user': { type: 'string' },
    'identity-file': { type: 'string' }, 'relay-identity-file': { type: 'string' },
    'known-hosts-file': { type: 'string' }, 'ssh-port': { type: 'string' }, 'relay-port': { type: 'string' },
    'pairing-file': { type: 'string' },
    'pairing-dir': { type: 'string' }, 'app-port': { type: 'string' }, 'tunnel-port': { type: 'string' },
    'max-retries': { type: 'string' },
  } });
  if (!command || command === 'help' || command === '--help' || command === '-h' || values.help) {
    console.log(HELP); return;
  }
  if (positionals.length) throw new Error('Unexpected positional arguments; pass Codex arguments after --');
  if (['init-app', 'init-app-client', 'publish-app', 'connect-app', 'check-app'].includes(command)) {
    const allowed = command === 'init-app' ? ['mock', 'ssh-target', 'identity-file', 'known-hosts-file', 'out', 'app-port', 'relay-port', 'ssh-port', 'max-retries']
      : command === 'init-app-client' ? ['mock', 'ssh-target', 'identity-file', 'known-hosts-file', 'pairing-dir', 'out', 'local-port', 'tunnel-port', 'relay-port', 'ssh-port', 'max-retries']
      : command === 'publish-app' ? ['server-config', 'json']
      : command === 'connect-app' ? ['client-config', 'json'] : ['client-config', 'out', 'interrupt-ssh', 'json'];
    if (userArgs.length || Object.keys(values).some(key => !allowed.includes(key))) throw new Error('Unsupported application command options');
    const event = value => console.log(values.json ? JSON.stringify(value) :
      (value.event === 'application' ? 'MOCK application ' + value.role + ': ' + value.state + (value.loopback_port ? ' (loopback ' + value.loopback_port + '; run doctor to verify)' : '')
        : 'SSH ' + value.direction + ': ' + value.state + (value.reason ? ' (' + value.reason + ')' : '') + (value.hint ? '; ' + value.hint : '')));
    if (command === 'init-app' || command === 'init-app-client') {
      const appOptions = { mock: values.mock, sshTarget: values['ssh-target'], identityFile: values['identity-file'],
        knownHostsFile: values['known-hosts-file'], pairingDirectory: values['pairing-dir'],
        appPort: values['app-port'] === undefined ? undefined : Number(values['app-port']),
        localPort: values['local-port'] === undefined ? undefined : Number(values['local-port']),
        tunnelPort: values['tunnel-port'] === undefined ? undefined : Number(values['tunnel-port']),
        relayPort: values['relay-port'] === undefined ? undefined : Number(values['relay-port']),
        sshPort: values['ssh-port'] === undefined ? undefined : Number(values['ssh-port']),
        maxRetries: values['max-retries'] === undefined ? undefined : Number(values['max-retries']) };
      if (command === 'init-app') {
        const result = await initializeApplicationPublisher(values.out || DEFAULT_APP_SERVER_ROOT, appOptions);
        console.log('MOCK application server configuration: ' + result.serverFile);
        console.log('Private B-only TLS pairing directory: ' + result.clientDirectory + '; do not upload publicly.');
      } else console.log('MOCK application client configuration: ' + await initializeApplicationClient(values.out || DEFAULT_APP_CLIENT_CONFIG, appOptions));
    } else if (command === 'check-app') {
      const result = await checkApplicationClient({ clientFile: values['client-config'], out: values.out,
        interruptSsh: values['interrupt-ssh'] }, { onEvent: event });
      console.log(values.json ? JSON.stringify({ event: 'check_summary', status: result.report.status, report_file: result.destination })
        : 'MOCK application checks: ' + result.report.status + '; report: ' + result.destination);
      process.exitCode = ['fail', 'interrupted'].includes(result.report.status) ? 1 : 0;
    } else {
      if (command === 'publish-app' && !values['server-config']) throw new Error('publish-app requires --server-config');
      const role = command === 'publish-app' ? 'publisher' : 'client';
      const config = await loadApplicationConfig(role === 'publisher' ? values['server-config'] : values['client-config'] || DEFAULT_APP_CLIENT_CONFIG, role);
      process.exitCode = await runApplication(config, { onEvent: event });
    }
    return;
  }
  if (['pairing-dir', 'app-port', 'tunnel-port', 'max-retries'].some(key => values[key] !== undefined)) throw new Error('Application options require an application command');
  const serverFile = values['server-config'] || DEFAULT_SERVER_CONFIG;
  const clientFile = values['client-config'] || DEFAULT_CLIENT_CONFIG;
  const publisherFile = values['publisher-config'] || DEFAULT_PUBLISHER_CONFIG;
  if (values.offline && command !== 'doctor') throw new Error('--offline is only supported by doctor');
  if (values.port !== undefined && command !== 'dev') throw new Error('--port is only supported by dev');
  if (values['interrupt-ssh'] && command !== 'check-lifecycle') throw new Error('--interrupt-ssh is only supported by check-lifecycle');
  if (values.json && !['doctor', 'publish', 'connect', 'dev', 'check-lifecycle'].includes(command)) throw new Error('--json is not supported by this command');
  const tunnelOptions = values.json ? { logger: () => {}, onEvent: event => console.log(JSON.stringify(event)) } : undefined;
  if (command === 'check-lifecycle') {
    if (!values['client-config'] || !values.out || userArgs.length
      || Object.keys(values).some(key => !['client-config', 'out', 'interrupt-ssh', 'json'].includes(key))) {
      throw new Error('check-lifecycle requires --client-config and --out; accepts only --interrupt-ssh and --json additionally');
    }
    const result = await runLifecycleChecks({ clientFile, out: values.out, interruptSsh: values['interrupt-ssh'] });
    console.log(values.json ? JSON.stringify({ event: 'check_summary', status: result.report.status, report_file: result.destination })
      : 'MOCK lifecycle: ' + result.report.status + '; report: ' + result.destination);
    process.exitCode = result.report.status === 'fail' ? 1 : 0;
    return;
  }
  if (command === 'dev') {
    if (Object.keys(values).some(key => !['port', 'out', 'json', 'help'].includes(key)) || userArgs.length) {
      throw new Error('dev accepts only --port, --out and --json; real HAI/client/server/SSH options are not accepted');
    }
    process.exitCode = await runDevelopment({ port: values.port === undefined ? undefined : Number(values.port), out: values.out }, { json: values.json });
    return;
  }
  if (command === 'doctor' && values.offline) {
    if ((values['client-config'] && values['publisher-config']) || values['server-config'] || values['base-url'] || values.infer) {
      throw new Error('Offline doctor accepts either client or publisher config, without --base-url, --server-config or --infer');
    }
    const role = values['publisher-config'] ? 'publisher' : 'client';
    const report = await diagnoseOffline({ role, file: role === 'publisher' ? publisherFile : clientFile });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatOfflineReport(report));
    process.exitCode = report.status === 'fail' ? 1 : 0;
    return;
  }
  if (command === 'init-publisher') {
    const file = await initializePublisher(publisherFile, {
      sshTarget: values['ssh-target'], identityFile: values['identity-file'], knownHostsFile: values['known-hosts-file'],
      sshPort: values['ssh-port'] === undefined ? undefined : Number(values['ssh-port']),
      relayPort: values['relay-port'] === undefined ? undefined : Number(values['relay-port']),
    });
    console.log('Publisher configuration created: ' + file);
    return;
  }
  if (command === 'publish') {
    process.exitCode = await runTunnel(await loadPublisherConfig(publisherFile), tunnelOptions);
    return;
  }
  if (command === 'init-relay-client') {
    const files = await initializeRelayClient(values.out || DEFAULT_CLIENT_CONFIG, {
      relayTarget: values['relay-target'], macUser: values['mac-user'],
      relayIdentityFile: values['relay-identity-file'], identityFile: values['identity-file'],
      knownHostsFile: values['known-hosts-file'], pairingFile: values['pairing-file'], mock: values.mock,
      sshPort: values['ssh-port'] === undefined ? undefined : Number(values['ssh-port']),
      relayPort: values['relay-port'] === undefined ? undefined : Number(values['relay-port']),
      localPort: values['local-port'] === undefined ? undefined : Number(values['local-port']),
    });
    console.log('Client configuration created: ' + files.clientFile);
    console.log('Dedicated SSH profile created: ' + files.sshConfigFile);
    console.log(files.mock ? 'MOCK ONLY: public fixture token, no HAI credentials. Start the mock service on A separately.'
      : 'Bridge token imported from pairing file; no HAI identity is copied.');
    return;
  }
  if (command === 'init-server') {
    const file = await initializeServer(serverFile, {
      upstreamUrl: values['upstream-url'], upstreamAuthFile: values['upstream-auth-file'],
    });
    console.log(`Server configuration created: ${file} (token stored separately, not printed)`);
    return;
  }
  if (command === 'pair') {
    const file = await exportClient(serverFile, values.out || DEFAULT_CLIENT_CONFIG, {
      sshTarget: values['ssh-target'], localPort: values['local-port'] ? Number(values['local-port']) : undefined,
      model: values.model,
    });
    console.log(`Client pairing file created: ${file}`);
    console.log('Transfer only this private pairing file to B; it contains the bridge token, not the HAI key.');
    return;
  }
  if (command === 'serve') {
    const config = await loadServerConfig(serverFile);
    const readers = credentialReaders(config);
    await readers.getBridgeToken();
    await readers.getUpstreamKey();
    const server = createBridge({ ...config, ...readers, logger: value => console.log(JSON.stringify(value)) });
    server.listen(config.listenPort, config.listenHost);
    await once(server, 'listening');
    console.log(`Bridge listening on http://${config.listenHost === '::1' ? '[::1]' : config.listenHost}:${config.listenPort}`);
    console.log(`HAI upstream: ${config.upstream.origin}. Use connect on B to establish the SSH tunnel.`);
    let shuttingDown = false;
    const stop = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const timer = setTimeout(() => server.closeAllConnections(), 5000);
      timer.unref();
      server.close(() => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
      server.closeIdleConnections();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (!['connect', 'doctor', 'probe', 'codex'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const config = await loadToolClient(clientFile);
  if (config.transport === APPLICATION_TRANSPORT && ['connect', 'codex'].includes(command)) throw new Error('Mock application config requires connect-app; real AI tool sessions are not implemented');
  if (config.transport === APPLICATION_TRANSPORT && values['base-url']) throw new Error('Mock application tools do not accept a base URL override');
  const origin = clientOrigin(config, values['base-url']);
  if (command === 'connect') {
    if (config.localOnly) throw new Error('Local-only dev configuration does not use SSH; run doctor or probe directly');
    process.exitCode = await runTunnel(config, tunnelOptions); return;
  }
  if (command === 'doctor' || (command === 'probe' && !values.infer)) {
    const result = await diagnose(config, origin);
    if (config.transport === APPLICATION_TRANSPORT && (!result.mock || !result.configured_model_available)) throw new Error('Expected the fixed mock application upstream');
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'probe') {
    if (config.transport === APPLICATION_TRANSPORT) {
      const result = await diagnose(config, origin);
      if (!result.mock || !result.configured_model_available) throw new Error('Refusing POST to a non-mock application upstream');
    }
    console.log(JSON.stringify(await probeInference(config, origin, values.model ?? (config.transport === APPLICATION_TRANSPORT ? config.model : undefined)), null, 2)); return;
  }
  process.exitCode = await runCodex(config, origin, userArgs);
}

main().catch(error => {
  // Never print configuration contents, credentials, request headers, or raw upstream bodies.
  console.error(`HAI Bridge: ${error.code === 'EEXIST' ? 'Output file already exists; choose another path' : error.message}`);
  process.exitCode = 1;
});
