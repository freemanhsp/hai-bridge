import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writePrivateFile, validatePort, validateSshTarget, loadClientConfig,
  sshValue, sshFile, sshOptions } from './config.mjs';

export const DEFAULT_PUBLISHER_CONFIG = '.local/publisher.json';
export const MOCK_RELAY_TOKEN = 'hai_bridge_public_mock_token_20261119';

function retries(value = 5) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('max_retries must be between 0 and 100');
  return value;
}

function endpoint(value) {
  validateSshTarget(value);
  const parts = value.split('@');
  if (parts.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || parts[0] === 'root') {
    throw new Error('Relay target must be a non-root user@host');
  }
  let host = parts[1];
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || host.startsWith('-') || !/^[A-Za-z0-9_.:-]+$/.test(host)) throw new Error('Invalid relay host');
  return { user: parts[0], host };
}

export async function initializePublisher(file = DEFAULT_PUBLISHER_CONFIG, options = {}) {
  endpoint(options.sshTarget);
  const config = {
    ssh_target: options.sshTarget, ssh_port: validatePort(options.sshPort ?? 22, 'ssh_port'),
    relay_port: validatePort(options.relayPort ?? 18083, 'relay_port'),
    reconnect: true, max_retries: 5,
  };
  if (options.identityFile !== undefined) config.identity_file = sshFile(options.identityFile);
  if (options.knownHostsFile !== undefined) config.known_hosts_file = sshFile(options.knownHostsFile);
  const destination = path.resolve(file);
  await writePrivateFile(destination, JSON.stringify(config, null, 2) + '\n');
  return destination;
}

export async function loadPublisherConfig(file = DEFAULT_PUBLISHER_CONFIG) {
  const destination = path.resolve(file), raw = await readJson(destination);
  endpoint(raw.ssh_target);
  // Publish SSH, never plaintext HAI/HTTP; listen address and destination are fixed loopback.
  return { target: raw.ssh_target, localPort: validatePort(raw.relay_port, 'relay_port'),
    remoteHost: '127.0.0.1', remotePort: 22, direction: 'remote', reconnect: raw.reconnect === true,
    maxRetries: retries(raw.max_retries), ...sshOptions(raw, path.dirname(destination)) };
}

export async function initializeRelayClient(file, options = {}) {
  const relay = endpoint(options.relayTarget);
  if (typeof options.macUser !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(options.macUser) || options.macUser === 'root') {
    throw new Error('mac_user must be a non-root SSH username');
  }
  if (options.mock && options.pairingFile) throw new Error('Choose --mock OR --pairing-file, not both');
  if (!options.mock && !options.pairingFile) throw new Error('Use --mock or provide --pairing-file');
  const paired = options.mock ? { token: MOCK_RELAY_TOKEN, localPort: 18084, remoteHost: '127.0.0.1', remotePort: 18080, model: 'relay-ok' }
    : await loadClientConfig(options.pairingFile, {});
  if (paired.localOnly) throw new Error('Local-only development configs are not cross-device pairings; use --mock for relay experiments');
  const output = path.resolve(file), profile = output + '.ssh_config';
  const localPort = validatePort(options.localPort ?? paired.localPort, 'local_port');
  const relayPort = validatePort(options.relayPort ?? 18083, 'relay_port');
  const jumpPort = validatePort(options.sshPort ?? 22, 'ssh_port');
  const relayIdentity = sshFile(options.relayIdentityFile);
  const macIdentity = sshFile(options.identityFile);
  const knownHosts = options.knownHostsFile === undefined ? undefined : sshFile(options.knownHostsFile);
  const known = knownHosts ? ['  UserKnownHostsFile ' + sshValue(knownHosts), '  GlobalKnownHostsFile none'] : [];
  const common = ['  IdentitiesOnly yes', '  BatchMode yes', '  StrictHostKeyChecking yes', '  ForwardAgent no',
    '  ConnectTimeout 10', '  ServerAliveInterval 15', '  ServerAliveCountMax 3', ...known];
  const text = [
    '# Generated HAI Bridge profile; contains paths, never private key contents.',
    'Host hai-bridge-relay', '  HostName ' + sshValue(relay.host), '  User ' + sshValue(relay.user),
    '  Port ' + jumpPort, '  IdentityFile ' + sshValue(relayIdentity), ...common,
    '', 'Host hai-bridge-mac', '  HostName 127.0.0.1', '  User ' + sshValue(options.macUser),
    '  Port ' + relayPort, '  HostKeyAlias hai-bridge-mac', '  IdentityFile ' + sshValue(macIdentity),
    '  ProxyJump hai-bridge-relay', ...common, '',
  ].join('\n');
  const client = { bridge_token: paired.token, ssh_target: 'hai-bridge-mac', ssh_config_file: path.basename(profile),
    local_port: localPort, remote_host: paired.remoteHost, remote_port: paired.remotePort,
    model: paired.model, reconnect: true, max_retries: 5 };
  // Check both first; exclusive creation still protects against races.
  for (const target of [output, profile]) {
    try { await fs.lstat(target); throw new Error('Output file already exists; choose another path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writePrivateFile(profile, text);
  try { await writePrivateFile(output, JSON.stringify(client, null, 2) + '\n'); }
  catch (error) { await fs.unlink(profile); throw error; }
  return { clientFile: output, sshConfigFile: profile, mock: Boolean(options.mock) };
}
