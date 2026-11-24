import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeApplicationConfig, loadApplicationConfig } from '../src/app-config.mjs';
import { initializeDevicePublisher } from '../src/device-config.mjs';
import { issueInvitation } from '../src/device-registry.mjs';
import { readPrivateJson } from '../src/device-store.mjs';
import { assertPortFree, runApplication } from '../src/app-runtime.mjs';
import { formatApplicationEvent } from '../src/app-status.mjs';

export async function prepareDeviceHai({ sourceFile, model, out = '.local/device-v2-hai' }, {
  api = { normalizeApplicationConfig, loadApplicationConfig, initializeDevicePublisher, issueInvitation, readPrivateJson, assertPortFree, runApplication },
  log = console.log, signals = process,
} = {}) {
  if (!sourceFile || !model) throw new Error('Explicit source real server config and model required');
  // Configuration metadata only: no old TLS keys or HAI auth contents loaded/exported here.
  const source = api.normalizeApplicationConfig(await api.readPrivateJson(path.resolve(sourceFile), 8192), path.resolve(sourceFile), 'publisher');
  if (source.mode !== 'hai') throw new Error('Existing real HAI app-tls publisher config required');
  await api.assertPortFree(source.appPort); // Never kill/take over an old publisher.
  const result = await api.initializeDevicePublisher(out, { hai: true, model, upstreamUrl: source.upstream.origin,
    upstreamAuthFile: source.authFile, sshTarget: source.target, identityFile: source.identityFile, knownHostsFile: source.knownHostsFile,
    sshPort: source.sshPort, relayPort: source.relayPort, appPort: source.appPort, maxRetries: source.maxRetries, reconnect: source.reconnect });
  const config = await api.loadApplicationConfig(result.serverFile, 'publisher');
  const invitation = await api.issueInvitation(config.deviceDirectory, path.join(result.directory, 'invite-windows-' + randomBytes(4).toString('hex') + '.json'));
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hai-bridge.mjs');
  log('A_CONFIG: ' + result.serverFile);
  log('PRIVATE_INVITATION: ' + invitation.file + ' (15 minutes; transfer privately)');
  log('Copy ONLY that invitation to B ~/.hai-bridge-v2-hai/invite-windows.json. Never copy A keys/auth.');
  log('After B prints its NEW full fingerprint, open a SECOND Mac terminal and run:');
  log('read "haiDeviceId?Paste the full B fingerprint: "; node ' + quote(cli) + ' approve-device --server-config ' + quote(result.serverFile) + ' --device-id "$haiDeviceId"');
  log('Keep THIS publisher terminal open. VPN/HAI must remain running; Ctrl-C stops only this publisher.');
  log('Restart later: node ' + quote(cli) + ' publish-app --server-config ' + quote(result.serverFile));
  const code = await api.runApplication(config, { signals, onEvent: event => log(formatApplicationEvent(event)) });
  return { ...result, invitation: invitation.file, code };
}

async function main() {
  const { values } = parseArgs({ options: { 'from-server-config': { type: 'string' }, model: { type: 'string' },
    out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('node scripts/prepare-device-hai.mjs --from-server-config EXISTING_REAL_APP_TLS_SERVER --model MODEL [--out PRIVATE_ROOT]\nCreates a NEW v2 real instance/invitation and runs it in foreground. Stop the old publisher first.'); return; }
  const result = await prepareDeviceHai({ sourceFile: values['from-server-config'], model: values.model, out: values.out });
  process.exitCode = result.code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('A preparation/publisher failed. Check old publisher ports, explicit real source config and SSH/HAI readiness. No listener killed or credentials printed.'); process.exitCode = 1; });
}
