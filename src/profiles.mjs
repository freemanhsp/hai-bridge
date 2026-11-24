import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadApplicationConfig, initializeApplicationClient } from './app-config.mjs';
import { writePrivateFile, readJson, sshFile } from './config.mjs';
import { createPrivate, readPrivateJson, replacePrivate } from './device-store.mjs';

export function profileDirectory(directory) {
  return directory === undefined ? path.join(os.homedir(), '.hai-bridge') : sshFile(directory);
}
export function defaultClientFile(directory) { return path.join(profileDirectory(directory), 'client.json'); }
export function validateClientDefault(raw) {
  if (!raw || raw.schema_version !== 1 || raw.role !== 'client-default'
      || Object.keys(raw).some(key => !['schema_version', 'role', 'client_config'].includes(key))
      || typeof raw.client_config !== 'string' || !path.isAbsolute(raw.client_config)) {
    throw new Error('Invalid client default; use use-client --client-config PATH. No configuration was changed.');
  }
  return sshFile(raw.client_config);
}

// Opt-in pointer: preserve the old default, keys and source configuration in place.
export async function rememberClient(sourceFile, directory) {
  if (!sourceFile) throw new Error('use-client requires --client-config from your successful real setup');
  const source = path.resolve(sourceFile), config = await loadApplicationConfig(source, 'client');
  if (config.mode !== 'hai') throw new Error('Daily startup requires a real HAI client, not mock');
  const root = profileDirectory(directory); await privateDirectory(root);
  const destination = path.join(root, 'client-default.json');
  if (source === destination) throw new Error('A client default cannot point to itself');
  const value = JSON.stringify({ schema_version: 1, role: 'client-default', client_config: source }, null, 2) + '\n';
  try {
    const old = await readPrivateJson(destination, 4096);
    if (validateClientDefault(old) !== source) await replacePrivate(destination, value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await createPrivate(destination, value);
  }
  return destination;
}

export async function resolveDefaultClientFile(directory) {
  const pointer = path.join(profileDirectory(directory), 'client-default.json');
  try { return validateClientDefault(await readPrivateJson(pointer, 4096)); }
  catch (error) {
    // A broken/unsafe pointer must never silently fall back to a different identity.
    if (error.code !== 'ENOENT') throw error;
    return defaultClientFile(directory);
  }
}
async function privateDirectory(directory) {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) {
      throw new Error('Profile directory must be private and not a symlink; no permissions changed');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

export async function setupClient(sourceFile, directory) {
  if (!sourceFile) throw new Error('setup-client requires --client-config from the successful real trial');
  const config = await loadApplicationConfig(sourceFile, 'client');
  if (config.mode !== 'hai') throw new Error('Daily startup requires a dedicated real HAI client, not mock');
  const root = profileDirectory(directory);
  await privateDirectory(root);
  if (config.transport === 'app-device') {
    // Remember this B's identity location; never copy its private key to create a second device.
    const raw = await readJson(path.resolve(sourceFile));
    const destination = defaultClientFile(root);
    await createPrivate(destination, JSON.stringify({ ...raw, device_dir: config.deviceDirectory,
      identity_file: config.identityFile, known_hosts_file: config.knownHostsFile }, null, 2) + '\n');
    return destination;
  }
  return initializeApplicationClient(defaultClientFile(root), { hai: true, pairingDirectory: config.tlsDirectory,
    sshTarget: config.target, identityFile: config.identityFile, knownHostsFile: config.knownHostsFile,
    sshPort: config.sshPort, relayPort: config.relayPort, localPort: config.localPort, tunnelPort: config.tunnelPort,
    reconnect: config.reconnect, maxRetries: config.maxRetries });
}

export async function setupPublisher(sourceFile, directory) {
  if (!sourceFile) throw new Error('setup-publisher requires --server-config');
  const source = path.resolve(sourceFile);
  const config = await loadApplicationConfig(source, 'publisher'); // Local validation only; no listener/SSH/model call.
  const root = profileDirectory(directory); await privateDirectory(root);
  const destination = path.join(root, 'publisher-default.json');
  await writePrivateFile(destination, JSON.stringify({ schema_version: config.transport === 'app-device' ? 2 : 1, transport: config.transport,
    role: 'publisher-default', server_config: source }, null, 2));
  return destination;
}

export async function defaultPublisherFile(directory) {
  const file = path.join(profileDirectory(directory), 'publisher-default.json');
  let raw;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Invalid pointer');
    raw = await readJson(file);
  } catch { throw new Error('No safe default publisher; run setup-publisher --server-config PATH or pass --server-config'); }
  if (!((raw.schema_version === 1 && raw.transport === 'app-tls') || (raw.schema_version === 2 && raw.transport === 'app-device')) || raw.role !== 'publisher-default'
      || Object.keys(raw).some(key => !['schema_version', 'transport', 'role', 'server_config'].includes(key))
      || typeof raw.server_config !== 'string' || !path.isAbsolute(raw.server_config)) throw new Error('Invalid publisher default; no configuration was changed');
  return sshFile(raw.server_config);
}
