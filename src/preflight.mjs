import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadClientConfig, sshFile } from './config.mjs';
import { loadPublisherConfig } from './relay-config.mjs';

const execute = promisify(execFile);
const PROFILE_FIELDS = new Set(['hostname', 'user', 'port', 'identityfile', 'userknownhostsfile',
  'globalknownhostsfile', 'hostkeyalias', 'proxyjump', 'identitiesonly', 'batchmode',
  'stricthostkeychecking', 'forwardagent', 'connecttimeout', 'serveraliveinterval', 'serveralivecountmax']);
const NOT_CHECKED = ['remote_reachability', 'ssh_authentication', 'live_host_key',
  'remote_forward_permissions', 'hai_availability'];

// Deliberately NOT ssh -G: Match exec/Include/ProxyCommand may execute arbitrary commands.
export function staticSshProfile(text) {
  const hosts = new Map();
  let block;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z]+)\s+(.+)$/.exec(trimmed);
    if (!match) return undefined;
    const field = match[1].toLowerCase();
    let value = match[2].trim();
    if (/[\x00-\x1f\x7f%$\x60]/.test(value)) return undefined;
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { return undefined; }
      if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f%$\x60]/.test(value)) return undefined;
    } else if (!value || /\s/.test(value)) return undefined;
    if (field === 'host') {
      if (!/^[A-Za-z0-9_.-]+$/.test(value) || hosts.has(value)) return undefined;
      block = {};
      hosts.set(value, block);
    } else {
      if (!block || !PROFILE_FIELDS.has(field) || Object.hasOwn(block, field)) return undefined;
      block[field] = value;
    }
  }
  return hosts.size ? hosts : undefined;
}

export async function probeLocalPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

export async function diagnoseOffline({ file, role = 'client' }, { files = fs, run = execute,
  probe = probeLocalPort, homeDirectory = os.homedir(), platform = process.platform,
  nodeVersion = process.versions.node, env = process.env } = {}) {
  if (!['client', 'publisher'].includes(role)) throw new Error('Offline role must be client or publisher');
  const checks = [];
  const add = (id, status, message, hint) => checks.push({ id, status, message, ...(hint ? { hint } : {}) });
  const command = (name, args) => run(name, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 262144, windowsHide: true });
  const report = () => ({ mode: 'offline', role, status: checks.some(c => c.status === 'fail') ? 'fail'
    : checks.some(c => c.status === 'warn') ? 'warn' : 'pass', checks, not_checked: [...NOT_CHECKED] });

  const nodeAvailable = Number(nodeVersion.split('.')[0]) >= 22;
  add('node', nodeAvailable ? 'pass' : 'fail', nodeAvailable ? 'Node.js 22+ is available.' : 'Node.js is older than 22.',
    nodeAvailable ? undefined : 'Use Node.js 22 or newer.');
  let sshAvailable = false;
  try {
    const result = await command('ssh', ['-V']);
    sshAvailable = /OpenSSH_/.test((result.stdout || '') + (result.stderr || ''));
  } catch {}
  add('ssh', sshAvailable ? 'pass' : 'fail', sshAvailable ? 'OpenSSH client is available.' : 'Cannot run the OpenSSH client.',
    sshAvailable ? undefined : 'Install OpenSSH Client and confirm ssh -V works in this terminal.');

  async function inspectFile(filename, id, { required = true, sensitive = false, key = false } = {}) {
    let stat;
    try {
      stat = await files.stat(filename);
      if (!stat.isFile()) throw new Error('not_file');
      await files.access(filename, constants.R_OK);
    } catch {
      if (required) add(id, 'fail', 'Required file is missing, unreadable or not a regular file.',
        'Check the configured path and access rights; paths in JSON are relative to that JSON file.');
      return undefined;
    }
    if (required) add(id, 'pass', key ? 'Identity file is readable; private key contents were not inspected.' : 'Required file is readable.');
    if (sensitive) {
      if (platform === 'win32') add(id + '.permissions', 'warn', 'Windows file ACLs were not checked.',
        'Confirm only the intended user can access this file; do not rely on Unix mode bits on Windows.');
      else if ((stat.mode & 0o077) !== 0) add(id + '.permissions', key ? 'fail' : 'warn', 'File has group or other-user permissions.',
        key ? 'Restrict this private key to its owner (normally chmod 600); do not copy or print its contents.'
          : 'Restrict this configuration to its owner (normally chmod 600).');
      else add(id + '.permissions', 'pass', 'Unix group and other-user permission bits are clear.');
    }
    return stat;
  }

  const configFile = path.resolve(file);
  const configStat = await inspectFile(configFile, 'config.file', { sensitive: true });
  if (!configStat) return report();
  if (configStat.size > 1048576) {
    add('config.format', 'fail', 'Configuration is unexpectedly large.', 'Use a normal HAI Bridge JSON configuration smaller than 1 MiB.');
    return report();
  }
  let config;
  try { config = role === 'publisher' ? await loadPublisherConfig(configFile) : await loadClientConfig(configFile, env); }
  catch {
    add('config.format', 'fail', 'Configuration failed JSON or field validation.',
      'Check JSON syntax, loopback destinations, ports, SSH fields and bridge token/model format. No configuration contents are printed.');
    return report();
  }
  add('config.format', 'pass', 'Configuration passed validation.');
  if (role === 'client' && env.HAI_BRIDGE_TOKEN) add('config.token_override', 'warn', 'HAI_BRIDGE_TOKEN overrides the client token.',
    'Confirm the override is intentional; its value is never displayed.');

  if (role === 'client') {
    try {
      await probe(config.localPort);
      add('local_port', 'pass', 'Client loopback port was briefly bound and released; it was free at that moment.');
    } catch (error) {
      add('local_port', 'warn', error.code === 'EADDRINUSE' ? 'Client loopback port is already occupied.' : 'Cannot check client loopback port availability.',
        error.code === 'EADDRINUSE' ? 'An existing tunnel may own it. Use online doctor to check it, or stop only your old test tunnel before starting another.'
          : 'Check local binding permissions; no remote port was probed.');
    }
  } else add('remote_port', 'skip', 'Publisher relay port is on ECS and cannot be checked offline.');

  if (config.identityFile) await inspectFile(config.identityFile, 'ssh.identity', { sensitive: true, key: true });

  async function checkTrust(host, index) {
    const prefix = 'hop_' + index;
    const alias = host.hostkeyalias;
    const port = Number(host.port || 22);
    if (!host.hostname || /[\s%$\x60]/.test(host.hostname) || !Number.isInteger(port) || port < 1 || port > 65535) {
      add(prefix + '.trust', 'warn', 'Effective host/port cannot be determined statically.', 'Check the actual SSH profile manually without disabling host-key verification.');
      return;
    }
    // HostKeyAlias is a complete lookup name; unlike HostName it is not suffixed with the port.
    const lookup = alias || (port === 22 ? host.hostname : '[' + host.hostname + ']:' + port);
    const explicit = Boolean(host.userknownhostsfile && host.userknownhostsfile !== 'none');
    if (host.userknownhostsfile === 'none') {
      add(prefix + '.trust', 'warn', 'User known_hosts is disabled.', 'Configure a pre-verified trust file; system trust was not evaluated offline.');
      return;
    }
    const candidates = explicit ? [sshFile(host.userknownhostsfile)]
      : [path.join(homeDirectory, '.ssh', 'known_hosts'), path.join(homeDirectory, '.ssh', 'known_hosts2')];
    let found = false, incomplete = false, revoked = false;
    for (const candidate of candidates) {
      if (!await inspectFile(candidate, prefix + '.known_hosts', { required: explicit })) continue;
      try {
        const result = await command('ssh-keygen', ['-F', lookup, '-f', candidate]);
        const entries = (result.stdout || '').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
        found ||= entries.length > 0;
        revoked ||= entries.some(line => /^@revoked\s/.test(line.trim()));
      } catch (error) { if (error.code !== 1) incomplete = true; }
    }
    if (revoked) add(prefix + '.trust', 'fail', 'Matching revoked host-key record exists.', 'Review the revocation through a trusted administrator; never remove it merely to connect.');
    else if (incomplete) add(prefix + '.trust', 'warn', 'Host-key lookup could not be completed.', 'Confirm ssh-keygen is available and the trust file is valid/readable.');
    else if (found) add(prefix + '.trust', 'pass', 'Existing host-key record found; no live fingerprint was fetched or verified.');
    else add(prefix + '.trust', explicit ? 'fail' : 'warn', 'No matching record found in the checked user trust files.',
      'Verify the host fingerprint through a trusted channel before enrollment. System trust files were not evaluated; no trust files were changed.');
  }

  if (config.sshConfigFile) {
    const stat = await inspectFile(config.sshConfigFile, 'ssh.profile', { sensitive: true });
    let hosts;
    if (stat && stat.size <= 1048576) {
      try { hosts = staticSshProfile(await files.readFile(config.sshConfigFile, 'utf8')); } catch {}
    }
    if (!hosts) add('ssh.profile_static', 'warn', 'SSH profile is complex, unreadable or unsupported for static inspection.',
      'Inspect Include/Match/ProxyCommand and dynamic rules manually. Offline doctor does not execute SSH config commands.');
    else {
      add('ssh.profile_static', 'pass', 'Simple explicit Host blocks parsed without executing SSH configuration.');
      let target = config.target.split('@').at(-1), index = 1;
      const visited = new Set();
      while (target && target !== 'none') {
        if (visited.has(target) || !hosts.has(target)) {
          add('ssh.hops', 'warn', 'SSH hop is cyclic or cannot be resolved to an explicit Host block.', 'Review ProxyJump aliases manually.');
          break;
        }
        visited.add(target);
        const host = { ...hosts.get(target) };
        if (index === 1) {
          if (config.knownHostsFile) host.userknownhostsfile = config.knownHostsFile;
          if (config.hostKeyAlias) host.hostkeyalias = config.hostKeyAlias;
          if (config.sshPort) host.port = config.sshPort;
        }
        if (host.identityfile) await inspectFile(sshFile(host.identityfile), 'hop_' + index + '.identity', { sensitive: true, key: true });
        else if (index !== 1 || !config.identityFile) add('hop_' + index + '.identity', 'warn', 'No explicit identity was checked for this hop.',
          'Default SSH identities/agent may be used; authentication is not verified offline.');
        await checkTrust(host, index);
        target = host.proxyjump;
        index++;
      }
    }
  } else if (role === 'publisher') {
    let hostname = config.target.split('@').at(-1);
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    if (!config.identityFile) add('ssh.identity', 'warn', 'No explicit publisher identity was checked.', 'Default identities/agent may be used; confirm public-key login separately.');
    await checkTrust({ hostname, port: config.sshPort, userknownhostsfile: config.knownHostsFile, hostkeyalias: config.hostKeyAlias }, 1);
  } else add('ssh.profile_static', 'warn', 'Legacy/global SSH configuration was not evaluated offline.',
    'Use a dedicated relay profile for static hop checks; default identities, agent and system/global trust remain unchecked.');
  return report();
}

export function formatOfflineReport(report) {
  const lines = ['OFFLINE ' + report.role + ' | ' + report.status.toUpperCase()];
  for (const check of report.checks) {
    lines.push('[' + check.status.toUpperCase() + '] ' + check.id + ': ' + check.message);
    if (check.hint) lines.push('  Next: ' + check.hint);
  }
  lines.push('NOT CHECKED: ' + report.not_checked.join(', '));
  return lines.join('\n');
}
