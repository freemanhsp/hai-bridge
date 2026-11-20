import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { buildRelease } from './pack.mjs';
import { loadPair } from '../src/app-identity.mjs';
import { CLIENT_IDENTITY_FILES, HAI_CLIENT_FILES, loadApplicationAccess } from '../src/app-config.mjs';
import { writePrivateFile } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
export async function buildApplicationDelivery({ pairingDirectory, mode = 'mock', outputRoot = path.join(root, '.local', 'app-delivery'), npmCli = process.env.npm_execpath } = {}) {
  if (typeof pairingDirectory !== 'string' || !pairingDirectory) throw new Error('Explicit private B pairing directory is required');
  await loadPair(pairingDirectory, 'client', { mode });
  if (mode === 'hai') await loadApplicationAccess(pairingDirectory);
  const release = await buildRelease({ outputRoot, npmCli });
  const bundleName = mode === 'hai' ? 'hai-app-hai-trial' : 'hai-app-cli-checks';
  const bundle = path.join(release.directory, bundleName);
  await writePrivateFile(path.join(bundle, release.filename), await fs.readFile(release.archive));
  const script = mode === 'hai' ? 'windows-hai-trial.ps1' : 'windows-app-checks.ps1';
  await writePrivateFile(path.join(bundle, script), await fs.readFile(path.join(root, 'scripts', script)));
  await writePrivateFile(path.join(bundle, 'README.md'), await fs.readFile(path.join(root, 'docs', mode === 'hai' ? 'real-hai.md' : 'application-cli.md')));
  for (const name of mode === 'hai' ? HAI_CLIENT_FILES : CLIENT_IDENTITY_FILES) await writePrivateFile(path.join(bundle, 'client-pair', name), await fs.readFile(path.join(pairingDirectory, name)));
  await writePrivateFile(path.join(bundle, 'bundle.json'), JSON.stringify({ transport: 'app-tls', mode,
    filename: release.filename, version: release.version, sha256: release.sha256 }, null, 2));
  const archive = path.join(release.directory, bundleName + '.tgz');
  await execute('tar', ['-czf', archive, '-C', release.directory, bundleName], { timeout: 30000 });
  await fs.chmod(archive, 0o600);
  const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await writePrivateFile(path.join(release.directory, 'APP-SHA256SUMS'), sha256 + '  ' + bundleName + '.tgz' + String.fromCharCode(10));
  return { archive, sha256, directory: release.directory, version: release.version };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'pairing-dir': { type: 'string' }, hai: { type: 'boolean' } } });
  buildApplicationDelivery({ pairingDirectory: values['pairing-dir'], mode: values.hai ? 'hai' : 'mock' }).then(value => console.log(JSON.stringify(value, null, 2))).catch(() => {
    console.error('Private application delivery failed; check selected mode, B pairing, npm allowlist and output permissions. Nothing was published.');
    process.exitCode = 1;
  });
}
