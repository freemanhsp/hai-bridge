import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { normalizeApplicationConfig, applicationModel, checkSshFiles } from './app-config.mjs';
import { readPrivate, readPrivateJson, createPrivate, privateDirectory, exactObject } from './device-store.mjs';
import { DEVICE_SCHEMA, DEVICE_TRANSPORT, initializeServerIdentity, loadServerIdentity, validateTrust, spkiPin, publicDeviceKey } from './device-identity.mjs';
import { validateInvitation, deviceLabel, loadRegistry } from './device-registry.mjs';
import { validateToken } from './config.mjs';

export function normalizeDeviceConfig(raw, file, role) {
  const extra = role === 'publisher' ? ['app_port', ...(raw?.mode === 'hai' ? ['upstream_url', 'upstream_auth_file'] : [])] : ['local_port', 'tunnel_port'];
  exactObject(raw, ['schema_version', 'transport', 'mode', 'role', 'ssh_target', 'ssh_port', 'identity_file',
    'known_hosts_file', 'relay_port', 'reconnect', 'max_retries', 'device_dir', ...extra]);
  if (raw.schema_version !== DEVICE_SCHEMA || raw.transport !== DEVICE_TRANSPORT) throw new Error('Unsupported device configuration');
  const { device_dir, ...common } = raw;
  const result = normalizeApplicationConfig({ ...common, schema_version: 1, transport: 'app-tls', tls_dir: device_dir }, file, role);
  return { ...result, transport: DEVICE_TRANSPORT, deviceDirectory: result.tlsDirectory };
}
function rawConfig(options, mode, role, deviceDirectory) {
  return { schema_version: DEVICE_SCHEMA, transport: DEVICE_TRANSPORT, mode, role,
    ssh_target: options.sshTarget, ssh_port: options.sshPort ?? 22,
    identity_file: path.resolve(options.identityFile || ''), known_hosts_file: path.resolve(options.knownHostsFile || ''),
    relay_port: options.relayPort ?? 18083, reconnect: options.reconnect ?? true, max_retries: options.maxRetries ?? 5,
    device_dir: deviceDirectory, ...(role === 'publisher' ? { app_port: options.appPort ?? 18081,
      ...(mode === 'hai' ? { upstream_url: options.upstreamUrl, upstream_auth_file: options.upstreamAuthFile } : {}) }
      : { local_port: options.localPort ?? 18084, tunnel_port: options.tunnelPort ?? 18085 }) };
}
export async function initializeDevicePublisher(outputRoot, options = {}) {
  if (Boolean(options.mock) === Boolean(options.hai) || !options.identityFile || !options.knownHostsFile) throw new Error('Device initialization needs exactly one of --mock/--hai and explicit SSH files');
  const mode = options.hai ? 'hai' : 'mock';
  if (mode === 'mock' && [options.upstreamUrl, options.upstreamAuthFile, options.model].some(value => value !== undefined)) throw new Error('Mock device profile cannot include HAI options');
  const model = mode === 'mock' ? 'relay-ok' : applicationModel(options.model);
  const trial = rawConfig(options, mode, 'publisher', '.');
  const normalized = normalizeDeviceConfig(trial, path.resolve(outputRoot, 'server.json'), 'publisher');
  await checkSshFiles(normalized.identityFile, normalized.knownHostsFile);
  const directory = await initializeServerIdentity(outputRoot, mode);
  const serverFile = path.join(directory, 'server.json');
  await createPrivate(path.join(directory, 'model.json'), JSON.stringify({ model }) + '\n');
  await createPrivate(serverFile, JSON.stringify({ ...trial, ...(mode === 'hai' ? { upstream_url: normalized.upstream.origin,
    upstream_auth_file: normalized.authFile } : {}), device_dir: '.' }, null, 2) + '\n');
  return { directory, serverFile };
}
export async function initializeDeviceClient(file, options = {}) {
  if (!options.invitationFile || !options.identityFile || !options.knownHostsFile) throw new Error('B requires --invitation and explicit SSH files');
  if (options.upstreamUrl || options.upstreamAuthFile) throw new Error('B cannot configure HAI credentials');
  const invite = validateInvitation(await readPrivateJson(path.resolve(options.invitationFile), 24000));
  const model = invite.trust.mode === 'mock' ? 'relay-ok' : applicationModel(options.model);
  const destination = path.resolve(file), directory = destination + '.device';
  const raw = rawConfig(options, invite.trust.mode, 'client', path.basename(directory));
  const config = normalizeDeviceConfig(raw, destination, 'client');
  await checkSshFiles(config.identityFile, config.knownHostsFile);
  for (const name of [destination, directory]) {
    try { await fs.lstat(name); throw Object.assign(new Error('Device output exists; choose a new path'), { code: 'EEXIST' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await privateDirectory(path.dirname(destination), { create: true });
  await fs.mkdir(directory, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const identity = { schema_version: DEVICE_SCHEMA, device_id: spkiPin(publicKey),
    public_key: publicKey.export({ type: 'spki', format: 'pem' }), label: deviceLabel(options.label),
    model, local_token: randomBytes(32).toString('base64url') };
  await createPrivate(path.join(directory, 'device.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await createPrivate(path.join(directory, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
  await createPrivate(path.join(directory, 'trust.json'), JSON.stringify(invite.trust, null, 2) + '\n');
  await createPrivate(path.join(directory, 'invitation.json'), JSON.stringify(invite, null, 2) + '\n');
  await createPrivate(destination, JSON.stringify(raw, null, 2) + '\n');
  return { clientFile: destination, device_id: identity.device_id, state: 'local_key_created_not_enrolled' };
}
export async function loadDeviceClientIdentity(directory) {
  const raw = await readPrivateJson(path.join(directory, 'identity.json'), 2048);
  exactObject(raw, ['schema_version', 'device_id', 'public_key', 'label', 'model', 'local_token']);
  const key = createPrivateKey(await readPrivate(path.join(directory, 'device.key'), 2048));
  if (raw.schema_version !== DEVICE_SCHEMA || key.asymmetricKeyType !== 'ed25519' || raw.device_id !== spkiPin(publicDeviceKey(raw.public_key))
      || spkiPin(createPublicKey(key)) !== raw.device_id) throw new Error('B device identity mismatch');
  deviceLabel(raw.label); applicationModel(raw.model); validateToken(raw.local_token);
  return { ...raw, key };
}
export async function loadDeviceConfig(file, role) {
  const raw = await readPrivateJson(path.resolve(file), 8192);
  const config = normalizeDeviceConfig(raw, file, role);
  await checkSshFiles(config.identityFile, config.knownHostsFile);
  if (role === 'publisher') {
    config.pair = await loadServerIdentity(config.deviceDirectory, { allowExpiredLeaf: true });
    await loadRegistry(config.deviceDirectory, config.pair.trust.instance_id);
    const metadata = await readPrivateJson(path.join(config.deviceDirectory, 'model.json'), 512); exactObject(metadata, ['model']);
    config.model = applicationModel(metadata.model);
  } else {
    const trust = await readPrivateJson(path.join(config.deviceDirectory, 'trust.json'), 20000); validateTrust(trust);
    const identity = await loadDeviceClientIdentity(config.deviceDirectory);
    if (trust.mode !== config.mode) throw new Error('Device profile mode mismatch');
    config.pair = { trust, identity }; config.token = identity.local_token; config.model = identity.model;
  }
  if (role === 'publisher' && config.pair.trust.mode !== config.mode) throw new Error('Device publisher mode mismatch');
  return config;
}
