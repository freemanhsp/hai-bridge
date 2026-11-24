import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, createPublicKey, createPrivateKey, createHash, X509Certificate, randomBytes } from 'node:crypto';
import { privateDirectory, readPrivate, readPrivateJson, createPrivate, replacePrivate, exactObject, withDeviceLock } from './device-store.mjs';

const execute = promisify(execFile);
export const DEVICE_TRANSPORT = 'app-device';
export const DEVICE_SCHEMA = 2;
const DAY = 86400000;
export const spkiPin = key => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
export const deviceName = mode => mode === 'mock' ? 'hai-bridge-device.mock' : 'hai-bridge-device.local';
export function publicDeviceKey(pem) {
  if (typeof pem !== 'string' || pem.length > 512) throw new Error('Invalid device public key');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }) !== pem) throw new Error('Device key must be canonical Ed25519');
  return key;
}
function validCertificate(certificate, now = Date.now()) {
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error('Device TLS trust expired or not yet valid; manual root repair may be required');
}
export function validateTrust(raw, now = Date.now()) {
  exactObject(raw, ['schema_version', 'transport', 'mode', 'instance_id', 'server_name', 'server_spki_pin', 'ca']);
  if (raw.schema_version !== DEVICE_SCHEMA || raw.transport !== DEVICE_TRANSPORT || !['mock', 'hai'].includes(raw.mode)
      || !/^[a-f0-9]{64}$/.test(raw.instance_id) || raw.server_name !== deviceName(raw.mode)
      || !/^[a-f0-9]{64}$/.test(raw.server_spki_pin) || typeof raw.ca !== 'string' || raw.ca.length > 16384
      || !/^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\n?$/.test(raw.ca)) throw new Error('Invalid device server trust');
  const root = new X509Certificate(raw.ca);
  if (!root.ca || !root.verify(root.publicKey)) throw new Error('Invalid device root');
  validCertificate(root, now);
  return { ...raw, root };
}
export function deviceTlsOptions(trust) {
  validateTrust(trust);
  return { ca: trust.ca, servername: trust.server_name, minVersion: 'TLSv1.3', rejectUnauthorized: true, agent: false,
    checkServerIdentity(name, cert) {
      return tls.checkServerIdentity(name, cert)
        || (spkiPin(new X509Certificate(cert.raw).publicKey) === trust.server_spki_pin
          ? undefined : new Error('Device server SPKI mismatch'));
    } };
}

export async function initializeServerIdentity(root, mode) {
  if (!['mock', 'hai'].includes(mode)) throw new Error('Invalid device mode');
  await privateDirectory(path.resolve(root), { create: true });
  const directory = await fs.mkdtemp(path.join(path.resolve(root), 'app-device-'));
  const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const ca = pair(), server = pair();
  await createPrivate(path.join(directory, 'ca.key'), ca.privateKey);
  await createPrivate(path.join(directory, 'server.key'), server.privateKey);
  const run = args => execute('openssl', args, { cwd: directory, timeout: 30000, maxBuffer: 8192 });
  await run(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '365',
    '-subj', '/CN=HAI Bridge private device CA', '-out', 'ca.pem',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await fs.chmod(path.join(directory, 'ca.pem'), 0o600);
  const trust = { schema_version: DEVICE_SCHEMA, transport: DEVICE_TRANSPORT, mode,
    instance_id: randomBytes(32).toString('hex'), server_name: deviceName(mode),
    server_spki_pin: spkiPin(createPublicKey(server.publicKey)), ca: (await readPrivate(path.join(directory, 'ca.pem'))).toString('utf8') };
  validateTrust(trust);
  await createPrivate(path.join(directory, 'trust.json'), JSON.stringify(trust, null, 2) + '\n');
  await createPrivate(path.join(directory, 'registry.json'), JSON.stringify({ schema_version: DEVICE_SCHEMA,
    instance_id: trust.instance_id, devices: [], invitations: [] }, null, 2) + '\n');
  await renewServerIdentity(directory, { force: true });
  return directory;
}
export async function loadServerIdentity(directory, { allowExpiredLeaf = false } = {}) {
  const trust = await readPrivateJson(path.join(directory, 'trust.json'), 20000);
  const { root } = validateTrust(trust);
  const [ca, caKey, cert, key] = await Promise.all(['ca.pem', 'ca.key', 'server.pem', 'server.key']
    .map(name => readPrivate(path.join(directory, name), 16384)));
  const leaf = new X509Certificate(cert);
  if (ca.toString('utf8') !== trust.ca || !root.checkPrivateKey(createPrivateKey(caKey))
      || !leaf.checkPrivateKey(createPrivateKey(key)) || spkiPin(leaf.publicKey) !== trust.server_spki_pin
      || !leaf.verify(root.publicKey) || leaf.ca || leaf.checkHost(trust.server_name) !== trust.server_name
      || !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || Date.parse(leaf.validTo) > Date.parse(root.validTo)) throw new Error('Device server identity mismatch');
  if (!allowExpiredLeaf) validCertificate(leaf);
  return { trust, ca, cert, key, expires: Date.parse(leaf.validTo), rootExpires: Date.parse(root.validTo) };
}
export async function renewServerIdentity(directory, { force = false } = {}) {
  return withDeviceLock(directory, async () => {
    const trust = await readPrivateJson(path.join(directory, 'trust.json'), 20000);
    const { root } = validateTrust(trust);
    const caKey = await readPrivate(path.join(directory, 'ca.key'), 16384);
    const key = await readPrivate(path.join(directory, 'server.key'), 16384);
    if (!root.checkPrivateKey(createPrivateKey(caKey)) || spkiPin(createPublicKey(createPrivateKey(key))) !== trust.server_spki_pin
        || (await readPrivate(path.join(directory, 'ca.pem'))).toString('utf8') !== trust.ca) throw new Error('Device signing identity mismatch');
    let previous;
    try { previous = await loadServerIdentity(directory, { allowExpiredLeaf: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!force && previous?.expires > Date.now() + 2 * DAY) return { ...previous, renewed: false };
    // Do not issue past the root, or silently replace it. OpenSSL -days is whole days.
    const days = Math.min(7, Math.floor((Date.parse(root.validTo) - Date.now() - 60000) / DAY));
    if (days < 1) throw new Error('Device root rotation required; transfer new trust explicitly');
    const temporary = await fs.mkdtemp(path.join(directory, '.renew-'));
    const run = args => execute('openssl', args, { cwd: temporary, timeout: 30000, maxBuffer: 8192 });
    try {
      await createPrivate(path.join(temporary, 'extensions'), [
        'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:' + trust.server_name, '' ].join('\n'));
      await run(['req', '-new', '-key', path.join(directory, 'server.key'), '-sha256',
        '-subj', '/CN=' + trust.server_name, '-out', 'server.csr']);
      await run(['x509', '-req', '-in', 'server.csr', '-CA', path.join(directory, 'ca.pem'),
        '-CAkey', path.join(directory, 'ca.key'), '-set_serial', '0x' + randomBytes(16).toString('hex'),
        '-days', String(days), '-sha256', '-extfile', 'extensions', '-out', 'server.pem']);
      await fs.chmod(path.join(temporary, 'server.pem'), 0o600);
      const cert = await readPrivate(path.join(temporary, 'server.pem'));
      const leaf = new X509Certificate(cert);
      validCertificate(leaf);
      if (!leaf.verify(root.publicKey) || !leaf.checkPrivateKey(createPrivateKey(key))
          || spkiPin(leaf.publicKey) !== trust.server_spki_pin || Date.parse(leaf.validTo) > Date.parse(root.validTo)) throw new Error('Invalid renewed certificate');
      if (previous) await replacePrivate(path.join(directory, 'server.pem'), cert);
      else await createPrivate(path.join(directory, 'server.pem'), cert);
      return { ...(await loadServerIdentity(directory)), renewed: true };
    } finally {
      for (const name of ['extensions', 'server.csr', 'server.pem']) await fs.unlink(path.join(temporary, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(temporary);
    }
  });
}
