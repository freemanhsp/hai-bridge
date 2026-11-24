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
import { formatApplicationEvent } from '../src/app-status.mjs';
import { checkApplicationClient } from '../src/app-checks.mjs';
import { tryHai } from '../src/hai-trial.mjs';
import { setupClient, setupPublisher, defaultPublisherFile } from '../src/profiles.mjs';
import { startSession } from '../src/session.mjs';
import { inspectApplication, formatApplicationInspection } from '../src/app-inspect.mjs';
import { initializeDevicePublisher, initializeDeviceClient } from '../src/device-config.mjs';
import { issueInvitation, loadRegistry, changeDeviceState } from '../src/device-registry.mjs';
import { enrollDevice } from '../src/device-enrollment.mjs';
import { checkDeviceClient } from '../src/device-checks.mjs';

const HELP = `HAI Bridge MVP — Node.js 22+

  version      [--json] (also --version / -v)
  setup-client --client-config EXISTING_REAL_CLIENT [--profile-dir DIRECTORY]
  setup-publisher --server-config PATH [--profile-dir DIRECTORY]
  start        [--client-config PATH] [--profile-dir DIRECTORY] [--project DIRECTORY] -- [CODEX ARGS...]
  init-device  (--mock | --hai --upstream-url URL --upstream-auth-file PATH --model MODEL)
               --ssh-target USER@ECS --identity-file PATH --known-hosts-file PATH --out PRIVATE_DIRECTORY
               [--app-port PORT] [--relay-port PORT] [--ssh-port PORT] [--max-retries N]
  invite-device --server-config V2_PATH --out NEW_PRIVATE_INVITATION
  init-device-client --invitation PRIVATE_FILE --label NAME [--model MODEL]
               --ssh-target USER@ECS --identity-file PATH --known-hosts-file PATH --out NEW_PRIVATE_CONFIG
               [--local-port PORT] [--tunnel-port PORT] [--relay-port PORT] [--ssh-port PORT] [--max-retries N]
  enroll-device --client-config V2_PATH [--json] (one-time; owns temporary outbound SSH)
  check-device --client-config APPROVED_V2_MOCK --out NEW_PRIVATE_REPORT [--json] (one B batch)
  devices      --server-config V2_PATH [--json] (local A administration)
  approve-device --server-config V2_PATH --device-id FULL_B_FINGERPRINT
  revoke-device  --server-config V2_PATH --device-id FULL_B_FINGERPRINT
  init-app     (--mock | --hai --upstream-url URL --upstream-auth-file PATH --model MODEL)
               --ssh-target USER@ECS --identity-file PATH --known-hosts-file PATH
               [--out DIRECTORY] [--app-port PORT] [--relay-port PORT] [--ssh-port PORT] [--max-retries N]
  init-app-client (--mock | --hai) --pairing-dir DIRECTORY --ssh-target USER@ECS --identity-file PATH --known-hosts-file PATH
                  [--out PATH] [--local-port PORT] [--tunnel-port PORT] [--relay-port PORT] [--ssh-port PORT] [--max-retries N]
  publish-app  [--server-config PATH | --profile-dir DIRECTORY] [--json]
  connect-app  [--client-config PATH] [--json]
  inspect-app  --role publisher|client [--server-config PATH | --client-config PATH | --profile-dir DIRECTORY]
               [--json] [--out NEW_REPORT_PATH] (offline; no SSH/HTTP/HAI requests)
  check-app    --client-config PATH --out PATH [--interrupt-ssh] [--json]
  try-hai      --client-config PATH --out PATH [--infer] [--json] (owns B connection; --infer is billable)
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
inspect-app checks application config/public certificate expiry and file metadata; private keys/HAI auth are not read.
dev starts only local mock services (default port 18090); config is temporary unless --out is set.
check-lifecycle is MOCK ONLY and owns its SSH; --interrupt-ssh intentionally stops that child to test recovery.
Application TLS supports isolated --mock or explicit --hai; A/B use outbound ECS SSH, never Mac system login.
check-app stays MOCK ONLY. --hai needs a new pairing and keeps all HAI credentials on A.
Application init needs OpenSSL on A only. B imports a private short-lived TLS pairing; never upload its keys.
V2 app-device: B generates its own long-lived key, A approves its fingerprint; no B client certificate.
V2 invites expire in 15 minutes; transfer privately. A server leaf renews automatically; roots need explicit repair.
V2 uses the same publish-app/connect-app/start commands, with an explicit new config; v1 is not migrated.
setup-client copies a real B profile privately to ~/.hai-bridge; setup-publisher remembers only A's config path.
Source checkout: npm run setup:publisher -- --server-config PATH (once), then npm run publish.
publish-app stays in foreground; forward_ready confirms only the relay listener, not B-to-HAI health.
start owns B connection + one Codex invocation; exit closes only its resources. Stop old connect-app first.
start keeps the project as Codex working directory; it does not install a background service.
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
    help: { type: 'boolean', short: 'h' }, infer: { type: 'boolean' }, mock: { type: 'boolean' }, hai: { type: 'boolean' },
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
    'profile-dir': { type: 'string' }, project: { type: 'string' }, role: { type: 'string' },
    invitation: { type: 'string' }, label: { type: 'string' }, 'device-id': { type: 'string' },
  } });
  if (!command || command === 'help' || command === '--help' || command === '-h' || values.help) {
    console.log(HELP); return;
  }
  if (positionals.length) throw new Error('Unexpected positional arguments; pass Codex arguments after --');
  if (command === 'inspect-app') {
    if (userArgs.length || Object.keys(values).some(key => !['role', 'server-config', 'client-config', 'profile-dir', 'json', 'out'].includes(key))
        || !['publisher', 'client'].includes(values.role)
        || (values.role === 'publisher' && values['client-config']) || (values.role === 'client' && values['server-config'])
        || (values['profile-dir'] && (values['server-config'] || values['client-config']))) {
      throw new Error('inspect-app requires --role publisher|client and matching config or profile-dir; online/inference/override options are not accepted');
    }
    const report = await inspectApplication({ role: values.role, file: values['server-config'] || values['client-config'],
      profileDir: values['profile-dir'], out: values.out });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatApplicationInspection(report));
    process.exitCode = report.status === 'fail' ? 1 : 0;
    return;
  }
  if (values.role !== undefined) throw new Error('--role is only supported by inspect-app');
  if (['init-device', 'init-device-client', 'invite-device', 'enroll-device', 'check-device', 'devices', 'approve-device', 'revoke-device'].includes(command)) {
    const common = ['ssh-target', 'identity-file', 'known-hosts-file', 'out', 'relay-port', 'ssh-port', 'max-retries'];
    const allowed = command === 'init-device' ? [...common, 'mock', 'hai', 'upstream-url', 'upstream-auth-file', 'model', 'app-port']
      : command === 'init-device-client' ? [...common, 'invitation', 'label', 'model', 'local-port', 'tunnel-port']
      : command === 'enroll-device' ? ['client-config', 'json'] : command === 'check-device' ? ['client-config', 'out', 'json'] : command === 'invite-device' ? ['server-config', 'out']
      : command === 'devices' ? ['server-config', 'json'] : ['server-config', 'device-id'];
    if (userArgs.length || Object.keys(values).some(key => !allowed.includes(key))) throw new Error('Unsupported device command options');
    if (command.startsWith('init-device')) {
      if (!values.out) throw new Error('Device init requires an explicit new private --out path');
      const number = key => values[key] === undefined ? undefined : Number(values[key]);
      const configOptions = { mock: values.mock, hai: values.hai, upstreamUrl: values['upstream-url'], upstreamAuthFile: values['upstream-auth-file'],
        model: values.model, sshTarget: values['ssh-target'], identityFile: values['identity-file'], knownHostsFile: values['known-hosts-file'],
        invitationFile: values.invitation, label: values.label, appPort: number('app-port'), localPort: number('local-port'),
        tunnelPort: number('tunnel-port'), relayPort: number('relay-port'), sshPort: number('ssh-port'), maxRetries: number('max-retries') };
      const result = command === 'init-device' ? await initializeDevicePublisher(values.out, configOptions)
        : await initializeDeviceClient(values.out, configOptions);
      console.log('Private v2 configuration: ' + (result.serverFile || result.clientFile));
      if (result.device_id) console.log('B device fingerprint: ' + result.device_id + '; compare on A before approval.');
      else console.log('Next: invite-device; existing v1 settings and services are unchanged.');
    } else if (command === 'check-device') {
      const result = await checkDeviceClient({ clientFile: values['client-config'], out: values.out }, {
        onEvent: event => console.error(values.json ? JSON.stringify(event) : formatApplicationEvent(event)) });
      console.log(values.json ? JSON.stringify(result.report, null, 2) : 'V2 MOCK checks: ' + result.report.status + '; report: ' + result.destination);
      process.exitCode = result.report.status === 'pass' ? 0 : 1;
    } else if (command === 'enroll-device') {
      if (!values['client-config']) throw new Error('enroll-device requires an explicit --client-config');
      const result = await enrollDevice(values['client-config'], { onEvent: event => console.error(values.json ? JSON.stringify(event) : formatApplicationEvent(event)) });
      console.log(values.json ? JSON.stringify(result) : 'B device: ' + result.device_id + '; ' + result.state + '. Approve on A, then connect-app.');
    } else {
      if (!values['server-config']) throw new Error('Device administration requires an explicit --server-config');
      const config = await loadApplicationConfig(values['server-config'], 'publisher');
      if (config.transport !== 'app-device') throw new Error('Device administration requires an independent v2 publisher');
      if (command === 'invite-device') {
        if (!values.out) throw new Error('invite-device requires a new private --out file');
        const result = await issueInvitation(config.deviceDirectory, values.out);
        console.log('Private invitation: ' + result.file + '; expires in 15 minutes. Transfer privately; no B/HAI private key included.');
      } else if (command === 'devices') {
        const registry = await loadRegistry(config.deviceDirectory, config.pair.trust.instance_id);
        const devices = registry.devices.map(({ device_id, label, state }) => ({ device_id, label, state }));
        console.log(values.json ? JSON.stringify({ devices }, null, 2) : devices.map(item => item.device_id + '  ' + item.state + '  ' + item.label).join('\n') || 'No devices enrolled.');
      } else {
        const result = await changeDeviceState(config.deviceDirectory, config.pair.trust.instance_id, values['device-id'], command === 'approve-device' ? 'approved' : 'revoked');
        console.log('Device ' + result.device_id + ': ' + result.state + ' saved.');
        console.log('Running-service enforcement is checked per request; active streams are cancelled by polling (normally within 500ms). No service acknowledgement was requested.');
      }
    }
    return;
  }
  if (['invitation', 'label', 'device-id'].some(key => values[key] !== undefined)) throw new Error('Device options require a device command');
  if (['setup-client', 'setup-publisher', 'start'].includes(command)) {
    const allowed = command === 'setup-client' ? ['client-config', 'profile-dir']
      : command === 'setup-publisher' ? ['server-config', 'profile-dir'] : ['client-config', 'profile-dir', 'project'];
    if (Object.keys(values).some(key => !allowed.includes(key)) || (command !== 'start' && userArgs.length)) throw new Error('Unsupported daily startup options');
    if (command === 'setup-client') {
      console.log('Private daily client: ' + await setupClient(values['client-config'], values['profile-dir']));
      console.log('Run hai-bridge start from your project. No HAI credentials were copied; v2 remembers this device key location, v1 retains pairing expiry.');
    } else if (command === 'setup-publisher') {
      console.log('Private publisher default: ' + await setupPublisher(values['server-config'], values['profile-dir']));
      console.log('配置路径已记住；日常启动：hai-bridge publish-app（源码目录：npm run publish）。');
      console.log('设置未启动服务或替换旧实例；启动前请先停止同端口的旧 publisher。');
    } else {
      process.exitCode = await startSession({ clientFile: values['client-config'], profileDir: values['profile-dir'],
        project: values.project, userArgs }, { onEvent(event) {
        if (event.event === 'session') {
          console.error('HAI session: ' + event.state);
          if (event.state === 'codex_starting') console.error('BILLABLE: Codex uses real HAI through A. Credentials stay outside your project; no session auto-restart.');
        } else if (event.state === 'failed' || event.state === 'retry_wait') console.error('HAI transport: ' + event.state + (event.reason ? ' (' + event.reason + ')' : ''));
      } });
    }
    return;
  }
  if (['init-app', 'init-app-client', 'publish-app', 'connect-app', 'check-app', 'try-hai'].includes(command)) {
    const allowed = command === 'init-app' ? ['mock', 'hai', 'upstream-url', 'upstream-auth-file', 'model', 'ssh-target', 'identity-file', 'known-hosts-file', 'out', 'app-port', 'relay-port', 'ssh-port', 'max-retries']
      : command === 'init-app-client' ? ['mock', 'hai', 'ssh-target', 'identity-file', 'known-hosts-file', 'pairing-dir', 'out', 'local-port', 'tunnel-port', 'relay-port', 'ssh-port', 'max-retries']
      : command === 'publish-app' ? ['server-config', 'profile-dir', 'json']
      : command === 'connect-app' ? ['client-config', 'json']
      : command === 'try-hai' ? ['client-config', 'out', 'infer', 'json'] : ['client-config', 'out', 'interrupt-ssh', 'json'];
    if (userArgs.length || Object.keys(values).some(key => !allowed.includes(key))) throw new Error('Unsupported application command options');
    const event = value => console.log(values.json ? JSON.stringify(value) : formatApplicationEvent(value));
    if (command === 'init-app' || command === 'init-app-client') {
      const appOptions = { mock: values.mock, hai: values.hai, upstreamUrl: values['upstream-url'], upstreamAuthFile: values['upstream-auth-file'], model: values.model,
        sshTarget: values['ssh-target'], identityFile: values['identity-file'],
        knownHostsFile: values['known-hosts-file'], pairingDirectory: values['pairing-dir'],
        appPort: values['app-port'] === undefined ? undefined : Number(values['app-port']),
        localPort: values['local-port'] === undefined ? undefined : Number(values['local-port']),
        tunnelPort: values['tunnel-port'] === undefined ? undefined : Number(values['tunnel-port']),
        relayPort: values['relay-port'] === undefined ? undefined : Number(values['relay-port']),
        sshPort: values['ssh-port'] === undefined ? undefined : Number(values['ssh-port']),
        maxRetries: values['max-retries'] === undefined ? undefined : Number(values['max-retries']) };
      if (command === 'init-app') {
        const result = await initializeApplicationPublisher(values.out || DEFAULT_APP_SERVER_ROOT, appOptions);
        console.log((values.hai ? 'HAI' : 'MOCK') + ' application server configuration: ' + result.serverFile);
        console.log('Private B-only TLS pairing directory: ' + result.clientDirectory + '; do not upload publicly.');
      } else console.log((values.hai ? 'HAI' : 'MOCK') + ' application client configuration: ' + await initializeApplicationClient(values.out || DEFAULT_APP_CLIENT_CONFIG, appOptions));
    } else if (command === 'try-hai') {
      if (values.infer) console.error('BILLABLE: one short real HAI Responses request; no model-request retries or prompt/output logging.');
      const result = await tryHai({ clientFile: values['client-config'], out: values.out, infer: values.infer }, { onEvent: event });
      console.log(values.json ? JSON.stringify({ event: 'trial_summary', status: result.report.status, report_file: result.destination })
        : 'HAI trial: ' + result.report.status + '; report: ' + result.destination);
      process.exitCode = ['fail', 'interrupted'].includes(result.report.status) ? 1 : 0;
    } else if (command === 'check-app') {
      const result = await checkApplicationClient({ clientFile: values['client-config'], out: values.out,
        interruptSsh: values['interrupt-ssh'] }, { onEvent: event });
      console.log(values.json ? JSON.stringify({ event: 'check_summary', status: result.report.status, report_file: result.destination })
        : 'MOCK application checks: ' + result.report.status + '; report: ' + result.destination);
      process.exitCode = ['fail', 'interrupted'].includes(result.report.status) ? 1 : 0;
    } else {
      const role = command === 'publish-app' ? 'publisher' : 'client';
      const file = role === 'publisher' ? values['server-config'] || await defaultPublisherFile(values['profile-dir'])
        : values['client-config'] || DEFAULT_APP_CLIENT_CONFIG;
      const config = await loadApplicationConfig(file, role);
      process.exitCode = await runApplication(config, { onEvent: event });
    }
    return;
  }
  if (['hai', 'pairing-dir', 'app-port', 'tunnel-port', 'max-retries', 'profile-dir', 'project'].some(key => values[key] !== undefined)) throw new Error('Application options require an application command');
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
  const application = [APPLICATION_TRANSPORT, 'app-device'].includes(config.transport);
  if (application && command === 'connect') throw new Error('Application config requires connect-app');
  if (application && command === 'codex' && config.mode !== 'hai') throw new Error('Real AI tool sessions require a dedicated --hai pairing, not mock');
  if (application && values['base-url']) throw new Error('Application tools do not accept a base URL override');
  const origin = clientOrigin(config, values['base-url']);
  if (command === 'connect') {
    if (config.localOnly) throw new Error('Local-only dev configuration does not use SSH; run doctor or probe directly');
    process.exitCode = await runTunnel(config, tunnelOptions); return;
  }
  if (command === 'doctor' || (command === 'probe' && !values.infer)) {
    const result = await diagnose(config, origin);
    if (config.transport === APPLICATION_TRANSPORT && (result.mock !== (config.mode === 'mock') || !result.configured_model_available)) throw new Error('Upstream mode or configured model does not match the application pairing');
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'probe') {
    if (application) {
      const result = await diagnose(config, origin);
      if (result.mock !== (config.mode === 'mock') || !result.configured_model_available) throw new Error('Refusing POST: application upstream mode or model mismatch');
      if (config.mode === 'hai') console.error('BILLABLE: one short real HAI Responses request.');
    }
    console.log(JSON.stringify(await probeInference(config, origin, values.model ?? (application ? config.model : undefined)), null, 2)); return;
  }
  if (application) {
    const result = await diagnose(config, origin);
    if (result.mock || !result.configured_model_available) throw new Error('Refusing Codex: real HAI model is not available');
    console.error('BILLABLE: Codex uses real HAI through A. Use only a non-sensitive test workspace for the first session.');
  }
  process.exitCode = await runCodex(config, origin, userArgs);
}

main().catch(error => {
  // Never print configuration contents, credentials, request headers, or raw upstream bodies.
  console.error(`HAI Bridge: ${error.code === 'EEXIST' ? 'Output file already exists; choose another path' : error.message}`);
  process.exitCode = 1;
});
