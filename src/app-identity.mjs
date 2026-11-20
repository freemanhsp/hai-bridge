import fs from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writePrivateFile } from './config.mjs';

const execute = promisify(execFile);
export const SERVER_NAME = 'hai-bridge-app.mock';
export const EXPERIMENT = 'hai-bridge-app-tls-mock-v1';
export const APPLICATION_SCHEMA = 1;
export const HAI_SERVER_NAME = 'hai-bridge-app.local';
export const HAI_PAIRING = 'hai-bridge-app-tls-hai-v1';
export function pairingIdentity(mode) {
  if (!['mock', 'hai'].includes(mode)) throw new Error('Unsupported application pairing mode');
  return mode === 'mock' ? { experiment: EXPERIMENT, server_name: SERVER_NAME }
    : { experiment: HAI_PAIRING, server_name: HAI_SERVER_NAME };
}
export const fingerprint = pem => new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();

// Keys are generated locally, never fixtures in Git. No existing directory is replaced.
export async function generatePair(outputRoot, { mode = 'mock' } = {}) {
  const identity = pairingIdentity(mode);
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(outputRoot, 'app-tls-'));
  try { return await generateMaterial(directory, identity); }
  finally {
    // Also discard a signing key after partial initialization; leave other private assets for diagnosis.
    await fs.unlink(path.join(directory, 'ca.key')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function generateMaterial(directory, identity) {
  const run = args => execute('openssl', args, { cwd: directory, timeout: 30000, maxBuffer: 8192 });
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '7',
    '-subj', '/CN=HAI Bridge short-lived application CA', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  for (const role of ['server', 'client']) {
    await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-subj', '/CN=' + (role === 'server' ? identity.server_name : 'hai-bridge-application-client'),
      '-keyout', role + '.key', '-out', role + '.csr']);
    const extension = ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=' + (role === 'server' ? 'serverAuth' : 'clientAuth'),
      ...(role === 'server' ? ['subjectAltName=DNS:' + identity.server_name] : [])].join(String.fromCharCode(10)) + String.fromCharCode(10);
    await writePrivateFile(path.join(directory, role + '.ext'), extension);
    await run(['x509', '-req', '-in', role + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-set_serial', role === 'server' ? '2' : '3', '-days', '7', '-sha256', '-extfile', role + '.ext', '-out', role + '.pem']);
    await fs.chmod(path.join(directory, role + '.key'), 0o600);
    await fs.unlink(path.join(directory, role + '.csr'));
    await fs.unlink(path.join(directory, role + '.ext'));
  }
  const pins = Object.fromEntries(await Promise.all(['server', 'client'].map(async role =>
    [role + '_pin', fingerprint(await fs.readFile(path.join(directory, role + '.pem')))])));
  await writePrivateFile(path.join(directory, 'pair.json'), JSON.stringify({ schema_version: APPLICATION_SCHEMA,
    ...identity, ...pins }, null, 2) + String.fromCharCode(10));
  return directory;
}

export async function loadPair(directory, role, { mode = 'mock' } = {}) {
  const identityMetadata = pairingIdentity(mode);
  if (!['server', 'client'].includes(role)) throw new Error('Invalid TLS role');
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'pair.json'), 'utf8'));
  const fields = ['schema_version', 'experiment', 'server_name', 'server_pin', 'client_pin'];
  if (metadata.schema_version !== APPLICATION_SCHEMA || metadata.experiment !== identityMetadata.experiment || metadata.server_name !== identityMetadata.server_name
      || !/^[a-f0-9]{64}$/.test(metadata.server_pin) || !/^[a-f0-9]{64}$/.test(metadata.client_pin)
      || Object.keys(metadata).some(field => !fields.includes(field))) {
    throw new Error('Invalid isolated application pairing for the selected mode');
  }
  const [ca, cert, key] = await Promise.all(['ca.pem', role + '.pem', role + '.key']
    .map(file => fs.readFile(path.join(directory, file))));
  const certificatePem = /^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
  if (![ca, cert].every(content => content.length <= 16384 && certificatePem.test(content.toString('utf8').trim()))) {
    throw new Error('Application certificate files must contain exactly one public certificate');
  }
  const keyPem = /^-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\r\n]+-----END \1-----$/;
  if (key.length > 16384 || !keyPem.test(key.toString('utf8').trim())) throw new Error('Application identity must contain exactly one private key');
  const keyInfo = await fs.stat(path.join(directory, role + '.key'));
  if (!keyInfo.isFile() || (process.platform !== 'win32' && (keyInfo.mode & 0o077))) throw new Error('Unsafe application key permissions');
  if (fingerprint(cert) !== metadata[role + '_pin']) throw new Error('Pair identity mismatch');
  const identity = new X509Certificate(cert);
  const authority = new X509Certificate(ca);
  if ([identity, authority].some(item => Date.parse(item.validTo) <= Date.now() || Date.parse(item.validFrom) > Date.now())) {
    throw new Error('Application certificate expired or not yet valid; prepare a new isolated pair');
  }
  if (!authority.ca || !identity.verify(authority.publicKey)
      || !identity.keyUsage?.includes('1.3.6.1.5.5.7.3.' + (role === 'server' ? '1' : '2'))) throw new Error('Invalid application certificate issuer or purpose');
  tls.createSecureContext({ ca, cert, key, minVersion: 'TLSv1.3' });
  return { ...metadata, ca, cert, key };
}
