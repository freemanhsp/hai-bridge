import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_SERVER_CONFIG = '.local/server.json';
export const DEFAULT_CLIENT_CONFIG = '.local/client.json';

export function validatePort(value, label, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) {
    throw new Error(`${label} must be an integer between ${allowZero ? 0 : 1} and 65535`);
  }
  return value;
}

export function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('URL must be an HTTP loopback origin without credentials, path, or query');
  }
  return url;
}

export function validateToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new Error('Bridge token must contain 32–256 URL-safe characters');
  }
  return value;
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON configuration: ${file}`);
    throw new Error(`Cannot read configuration: ${file}`);
  }
}

export async function writePrivateFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Exclusive creation deliberately refuses to replace existing configuration or tokens.
  await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
}

export async function initializeServer(file = DEFAULT_SERVER_CONFIG, options = {}) {
  const configFile = path.resolve(file);
  try {
    await fs.access(configFile);
    throw new Error(`Configuration already exists: ${configFile}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const upstreamUrl = loopbackUrl(options.upstreamUrl || 'http://127.0.0.1:6655').origin;
  const tokenFile = path.join(path.dirname(configFile), 'bridge.token');
  try {
    validateToken((await fs.readFile(tokenFile, 'utf8')).trim());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writePrivateFile(tokenFile, randomBytes(32).toString('base64url') + '\n');
  }
  const config = {
    listen_host: '127.0.0.1', listen_port: 16656, upstream_url: upstreamUrl,
    upstream_auth_file: path.resolve(options.upstreamAuthFile || path.join(os.homedir(), '.codex', 'auth.json')),
    bridge_token_file: 'bridge.token', idle_timeout_ms: 120000, max_request_bytes: 67108864,
    allowed_providers: ['openai'],
  };
  await writePrivateFile(configFile, JSON.stringify(config, null, 2) + '\n');
  return configFile;
}

export async function loadServerConfig(file = DEFAULT_SERVER_CONFIG) {
  const configFile = path.resolve(file);
  const raw = await readJson(configFile);
  if (!['127.0.0.1', '::1'].includes(raw.listen_host)) {
    throw new Error('MVP bridge must listen on 127.0.0.1 or ::1; use SSH for remote access');
  }
  const upstream = loopbackUrl(raw.upstream_url);
  const providers = raw.allowed_providers || ['openai'];
  if (!Array.isArray(providers) || providers.length === 0
      || providers.some(value => !['openai', 'litellm', 'anthropic', 'gemini'].includes(value))) {
    throw new Error('Invalid allowed_providers');
  }
  for (const name of ['idle_timeout_ms', 'max_request_bytes']) {
    if (!Number.isSafeInteger(raw[name]) || raw[name] <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const resolveFile = value => {
    if (typeof value !== 'string' || !value) throw new Error('Credential file path is required');
    return path.resolve(path.dirname(configFile), value);
  };
  return {
    listenHost: raw.listen_host, listenPort: validatePort(raw.listen_port, 'listen_port'), upstream,
    tokenFile: resolveFile(raw.bridge_token_file), authFile: resolveFile(raw.upstream_auth_file),
    idleTimeoutMs: raw.idle_timeout_ms, maxRequestBytes: raw.max_request_bytes, providers,
  };
}

export function credentialReaders(config, env = process.env) {
  return {
    // Files are read per request, so key rotation does not require a bridge restart.
    getBridgeToken: async () => validateToken(env.HAI_BRIDGE_TOKEN
      || (await fs.readFile(config.tokenFile, 'utf8')).trim()),
    getUpstreamKey: async () => {
      const value = env.HAI_UPSTREAM_API_KEY || (await readJson(config.authFile)).OPENAI_API_KEY;
      if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
        throw new Error('HAI local API key unavailable');
      }
      return value.trim();
    },
  };
}

export function validateSshTarget(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_@.:[\]-]+$/.test(value) || value.startsWith('-')) {
    throw new Error('ssh_target must be a hostname, SSH host alias, or user@host');
  }
  return value;
}

export function sshValue(value) {
  if (typeof value !== 'string' || !value || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('SSH configuration values must be nonempty and contain no control characters');
  }
  return JSON.stringify(process.platform === 'win32' ? value.split(String.fromCharCode(92)).join('/') : value);
}

export function sshFile(value, directory = process.cwd()) {
  sshValue(value);
  if (value.startsWith('~/')) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(directory, value);
}

export function sshOptions(raw, directory) {
  const file = value => value === undefined ? undefined : sshFile(value, directory);
  const alias = raw.ssh_host_key_alias;
  if (alias !== undefined && (typeof alias !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(alias))) {
    throw new Error('Invalid ssh_host_key_alias');
  }
  return {
    sshPort: raw.ssh_port === undefined ? undefined : validatePort(raw.ssh_port, 'ssh_port'),
    identityFile: file(raw.identity_file), sshConfigFile: file(raw.ssh_config_file),
    knownHostsFile: file(raw.known_hosts_file), hostKeyAlias: alias,
  };
}

export async function exportClient(serverFile, outputFile, options) {
  const config = await loadServerConfig(serverFile);
  const bridgeToken = await credentialReaders(config).getBridgeToken();
  const client = {
    bridge_token: bridgeToken, ssh_target: validateSshTarget(options.sshTarget),
    local_port: validatePort(options.localPort || 16655, 'local_port'),
    remote_host: config.listenHost, remote_port: config.listenPort,
    model: options.model || 'gpt-6.1-sol', reconnect: true, max_retries: 5,
  };
  const destination = path.resolve(outputFile);
  await writePrivateFile(destination, JSON.stringify(client, null, 2) + '\n');
  return destination;
}

export async function loadClientConfig(file = DEFAULT_CLIENT_CONFIG, env = process.env) {
  const configFile = path.resolve(file);
  const raw = await readJson(configFile);
  if (raw.local_only !== undefined && typeof raw.local_only !== 'boolean') throw new Error('local_only must be a boolean');
  if (!['127.0.0.1', '::1'].includes(raw.remote_host)) throw new Error('Remote destination must be loopback');
  if (typeof raw.model !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(raw.model)) throw new Error('Invalid model');
  if (!Number.isInteger(raw.max_retries) || raw.max_retries < 0 || raw.max_retries > 100) {
    throw new Error('max_retries must be between 0 and 100');
  }
  return {
    token: validateToken(env.HAI_BRIDGE_TOKEN || raw.bridge_token), target: validateSshTarget(raw.ssh_target),
    localPort: validatePort(raw.local_port, 'local_port'), remoteHost: raw.remote_host,
    remotePort: validatePort(raw.remote_port, 'remote_port'), model: raw.model,
    reconnect: raw.reconnect === true, maxRetries: raw.max_retries, localOnly: raw.local_only === true,
    ...sshOptions(raw, path.dirname(configFile)),
  };
}
