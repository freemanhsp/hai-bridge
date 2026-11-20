import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writePrivateFile, validatePort, validateSshTarget, sshFile, loadClientConfig } from './config.mjs';
import { generatePair, loadPair, APPLICATION_SCHEMA } from './app-identity.mjs';
import { DEV_TOKEN } from './dev.mjs';

export const APPLICATION_TRANSPORT = 'app-tls';
export const DEFAULT_APP_SERVER_ROOT = '.local/app';
export const DEFAULT_APP_CLIENT_CONFIG = '.local/app-client.json';
export const CLIENT_IDENTITY_FILES = ['ca.pem', 'client.pem', 'client.key', 'pair.json'];

export function applicationPort(value, label) {
  validatePort(value, label);
  if (value < 1024) throw new Error('Application ports must be unprivileged (1024 or higher)');
  return value;
}
function endpoint(value) {
  validateSshTarget(value);
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9.:[\]-]+$/.test(value) || value.split('@')[0] === 'root') {
    throw new Error('Application relay requires an explicit non-root user@ECS host');
  }
  return value;
}
function retryBudget(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error('Application max_retries must be between 0 and 10');
  return value;
}
async function checkSshFiles(identityFile, knownHostsFile) {
  for (const [file, privateKey] of [[identityFile, true], [knownHostsFile, false]]) {
    const info = await fs.stat(file);
    if (!info.isFile()) throw new Error('SSH identity and trust must be regular files');
    if (process.platform !== 'win32' && (info.mode & (privateKey ? 0o077 : 0o022))) {
      throw new Error('Unsafe SSH file permissions; no permissions were changed');
    }
  }
  // Windows ACLs are not repaired or certified here; OpenSSH remains the authentication authority.
}
function commonOptions(options) {
  if (!options.mock) throw new Error('Application CLI currently requires --mock; real HAI is not implemented');
  return { schema_version: APPLICATION_SCHEMA, transport: APPLICATION_TRANSPORT, mode: 'mock',
    ssh_target: endpoint(options.sshTarget), ssh_port: validatePort(options.sshPort ?? 22, 'ssh_port'),
    identity_file: sshFile(options.identityFile), known_hosts_file: sshFile(options.knownHostsFile),
    relay_port: applicationPort(options.relayPort ?? 18083, 'relay_port'),
    reconnect: true, max_retries: retryBudget(options.maxRetries ?? 5) };
}

export async function initializeApplicationPublisher(outputRoot = DEFAULT_APP_SERVER_ROOT, options = {}) {
  const common = commonOptions(options);
  const appPort = applicationPort(options.appPort ?? 18081, 'app_port');
  await checkSshFiles(common.identity_file, common.known_hosts_file);
  const directory = await generatePair(path.resolve(outputRoot));
  const serverFile = path.join(directory, 'server.json'), clientDirectory = path.join(directory, 'client-pair');
  await writePrivateFile(serverFile, JSON.stringify({ ...common, role: 'publisher', tls_dir: '.', app_port: appPort }, null, 2));
  for (const file of CLIENT_IDENTITY_FILES) {
    await writePrivateFile(path.join(clientDirectory, file), await fs.readFile(path.join(directory, file)));
  }
  return { directory, serverFile, clientDirectory };
}

export async function initializeApplicationClient(file = DEFAULT_APP_CLIENT_CONFIG, options = {}) {
  const common = commonOptions(options);
  const localPort = applicationPort(options.localPort ?? 18084, 'local_port');
  const tunnelPort = applicationPort(options.tunnelPort ?? 18085, 'tunnel_port');
  if (localPort === tunnelPort) throw new Error('HTTP and TLS tunnel ports must differ');
  const destination = path.resolve(file), tlsDirectory = destination + '.tls';
  for (const target of [destination, tlsDirectory]) {
    try { await fs.lstat(target); throw Object.assign(new Error('Application output exists; choose a new path'), { code: 'EEXIST' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (typeof options.pairingDirectory !== 'string' || !options.pairingDirectory) throw new Error('Client requires a private --pairing-dir');
  const input = path.resolve(options.pairingDirectory);
  await loadPair(input, 'client');
  await checkSshFiles(common.identity_file, common.known_hosts_file);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.mkdir(tlsDirectory, { mode: 0o700 });
  const written = [];
  try {
    for (const name of CLIENT_IDENTITY_FILES) {
      const target = path.join(tlsDirectory, name);
      await writePrivateFile(target, await fs.readFile(path.join(input, name)));
      written.push(target);
    }
    await writePrivateFile(destination, JSON.stringify({ ...common, role: 'client',
      tls_dir: path.basename(tlsDirectory), local_port: localPort, tunnel_port: tunnelPort }, null, 2));
    return destination;
  } catch (error) {
    for (const target of written) await fs.unlink(target);
    await fs.rmdir(tlsDirectory);
    throw error;
  }
}

export async function loadApplicationConfig(file, role) {
  if (!['publisher', 'client'].includes(role)) throw new Error('Invalid application role');
  const configFile = path.resolve(file), raw = await readJson(configFile);
  const allowed = ['schema_version', 'transport', 'mode', 'role', 'ssh_target', 'ssh_port', 'identity_file',
    'known_hosts_file', 'relay_port', 'reconnect', 'max_retries', 'tls_dir',
    ...(role === 'publisher' ? ['app_port'] : ['local_port', 'tunnel_port'])];
  if (raw.schema_version !== APPLICATION_SCHEMA || raw.transport !== APPLICATION_TRANSPORT || raw.mode !== 'mock'
      || raw.role !== role || Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new Error('Unsupported application configuration; only versioned mock app-tls is accepted');
  }
  if (typeof raw.reconnect !== 'boolean') throw new Error('Application reconnect must be a boolean');
  const directory = path.dirname(configFile);
  const identityFile = sshFile(raw.identity_file, directory), knownHostsFile = sshFile(raw.known_hosts_file, directory);
  await checkSshFiles(identityFile, knownHostsFile);
  if (typeof raw.tls_dir !== 'string' || !raw.tls_dir || /[\x00-\x1f]/.test(raw.tls_dir)) throw new Error('Invalid application TLS directory');
  const tlsDirectory = path.resolve(directory, raw.tls_dir);
  // Certificates are validated for validity, pin, private-key match and use before any network side effect.
  const pair = await loadPair(tlsDirectory, role === 'publisher' ? 'server' : 'client');
  const result = { role, transport: APPLICATION_TRANSPORT, mode: 'mock', pair, tlsDirectory,
    target: endpoint(raw.ssh_target), sshPort: validatePort(raw.ssh_port, 'ssh_port'),
    identityFile, knownHostsFile, relayPort: applicationPort(raw.relay_port, 'relay_port'),
    reconnect: raw.reconnect, maxRetries: retryBudget(raw.max_retries), token: DEV_TOKEN, model: 'relay-ok' };
  if (role === 'publisher') result.appPort = applicationPort(raw.app_port, 'app_port');
  else {
    result.localPort = applicationPort(raw.local_port, 'local_port');
    result.tunnelPort = applicationPort(raw.tunnel_port, 'tunnel_port');
    if (result.localPort === result.tunnelPort) throw new Error('HTTP and TLS tunnel ports must differ');
  }
  return result;
}

export async function loadToolClient(file, env = process.env) {
  const raw = await readJson(file);
  return raw.transport === APPLICATION_TRANSPORT ? loadApplicationConfig(file, 'client') : loadClientConfig(file, env);
}
