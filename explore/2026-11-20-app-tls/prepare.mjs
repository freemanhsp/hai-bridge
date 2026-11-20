import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generatePair, EXPERIMENT } from './certificates.mjs';
import { writePrivateFile } from '../../src/config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const relative = 'explore/2026-11-20-app-tls/';
const execute = promisify(execFile);
export const BUNDLE_FILES = ['src/bridge.mjs', 'src/config.mjs', 'src/dev.mjs', 'src/tunnel.mjs',
  ...['certificates.mjs', 'transport.mjs', 'checks.mjs', 'ssh.mjs', 'run.mjs'].map(file => relative + file)];

export async function prepareBundle({ outputRoot = path.join(root, '.local', 'app-tls') } = {}) {
  const directory = await generatePair(outputRoot);
  const bundle = path.join(directory, 'hai-app-tls-checks');
  for (const file of BUNDLE_FILES) {
    await writePrivateFile(path.join(bundle, file), await fs.readFile(path.join(root, file)));
  }
  for (const [from, to] of [['windows-checks.ps1', 'windows-checks.ps1'], ['README.md', 'README.md']]) {
    await writePrivateFile(path.join(bundle, to), await fs.readFile(path.join(root, relative, from)));
  }
  for (const file of ['client.key', 'client.pem', 'ca.pem', 'pair.json']) {
    await writePrivateFile(path.join(bundle, 'client', file), await fs.readFile(path.join(directory, file)));
  }
  const archive = path.join(directory, 'hai-app-tls-checks.tgz');
  // Exact generated subtree, never the project root, A identity or arbitrary credential folders.
  await execute('tar', ['-czf', archive, '-C', directory, 'hai-app-tls-checks'], { timeout: 30000 });
  await fs.chmod(archive, 0o600);
  const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await writePrivateFile(path.join(directory, 'SHA256SUMS'), sha256 + '  hai-app-tls-checks.tgz' + String.fromCharCode(10));
  const manifest = { experiment: EXPERIMENT, mock: true, node_required: '>=22', sha256,
    files: [...BUNDLE_FILES, 'windows-checks.ps1', 'README.md', ...['client.key', 'client.pem', 'ca.pem', 'pair.json'].map(f => 'client/' + f)],
    contains: 'B short-lived mock TLS identity only; not A identity, CA signing key or HAI authentication' };
  await writePrivateFile(path.join(directory, 'delivery.json'), JSON.stringify(manifest, null, 2) + String.fromCharCode(10));
  return { directory, archive, sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('prepare takes no arguments; output is always .local/app-tls');
  prepareBundle().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error('Mock TLS preparation failed; check OpenSSL with -addext, tar and .local permissions. No existing pairing is overwritten.');
    process.exitCode = 1;
  });
}
