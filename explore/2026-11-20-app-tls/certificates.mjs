import fs from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writePrivateFile } from '../../src/config.mjs';

const execute = promisify(execFile);
export const SERVER_NAME = 'hai-bridge-app.mock';
export const EXPERIMENT = 'hai-bridge-app-tls-mock-v1';
export const fingerprint = pem => new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();

// Keys are generated locally, never fixtures in Git. No existing directory is replaced.
export async function generatePair(outputRoot) {
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(outputRoot, 'app-tls-'));
  const run = args => execute('openssl', args, { cwd: directory, timeout: 30000, maxBuffer: 8192 });
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '7',
    '-subj', '/CN=HAI Bridge isolated mock CA', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  for (const role of ['server', 'client']) {
    await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-subj', '/CN=' + (role === 'server' ? SERVER_NAME : 'hai-bridge-mock-client'),
      '-keyout', role + '.key', '-out', role + '.csr']);
    const extension = ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=' + (role === 'server' ? 'serverAuth' : 'clientAuth'),
      ...(role === 'server' ? ['subjectAltName=DNS:' + SERVER_NAME] : [])].join(String.fromCharCode(10)) + String.fromCharCode(10);
    await writePrivateFile(path.join(directory, role + '.ext'), extension);
    await run(['x509', '-req', '-in', role + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-set_serial', role === 'server' ? '2' : '3', '-days', '7', '-sha256', '-extfile', role + '.ext', '-out', role + '.pem']);
    await fs.chmod(path.join(directory, role + '.key'), 0o600);
    await fs.unlink(path.join(directory, role + '.csr'));
    await fs.unlink(path.join(directory, role + '.ext'));
  }
  // No renewal/signing service: the short-lived experiment CA private key is discarded.
  await fs.unlink(path.join(directory, 'ca.key'));
  const pins = Object.fromEntries(await Promise.all(['server', 'client'].map(async role =>
    [role + '_pin', fingerprint(await fs.readFile(path.join(directory, role + '.pem')))])));
  await writePrivateFile(path.join(directory, 'pair.json'), JSON.stringify({ experiment: EXPERIMENT,
    server_name: SERVER_NAME, ...pins }, null, 2) + String.fromCharCode(10));
  return directory;
}

export async function loadPair(directory, role) {
  if (!['server', 'client'].includes(role)) throw new Error('Invalid TLS role');
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'pair.json'), 'utf8'));
  if (metadata.experiment !== EXPERIMENT || metadata.server_name !== SERVER_NAME
      || !/^[a-f0-9]{64}$/.test(metadata.server_pin) || !/^[a-f0-9]{64}$/.test(metadata.client_pin)) {
    throw new Error('Invalid isolated mock pairing');
  }
  const [ca, cert, key] = await Promise.all(['ca.pem', role + '.pem', role + '.key']
    .map(file => fs.readFile(path.join(directory, file))));
  if (fingerprint(cert) !== metadata[role + '_pin']) throw new Error('Pair identity mismatch');
  const identity = new X509Certificate(cert);
  if (Date.parse(identity.validTo) <= Date.now() || Date.parse(identity.validFrom) > Date.now()) {
    throw new Error('Mock certificate expired or not yet valid; prepare a new isolated pair');
  }
  return { ...metadata, ca, cert, key };
}
