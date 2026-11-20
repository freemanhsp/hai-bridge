import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { buildRelease } from './pack.mjs';
import { loadPair } from '../src/app-identity.mjs';
import { CLIENT_IDENTITY_FILES } from '../src/app-config.mjs';
import { writePrivateFile } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
export async function buildApplicationDelivery({ pairingDirectory, outputRoot = path.join(root, '.local', 'app-delivery'), npmCli = process.env.npm_execpath } = {}) {
  if (typeof pairingDirectory !== 'string' || !pairingDirectory) throw new Error('Explicit private B pairing directory is required');
  await loadPair(pairingDirectory, 'client');
  const release = await buildRelease({ outputRoot, npmCli });
  const bundle = path.join(release.directory, 'hai-app-cli-checks');
  await writePrivateFile(path.join(bundle, release.filename), await fs.readFile(release.archive));
  await writePrivateFile(path.join(bundle, 'windows-app-checks.ps1'), await fs.readFile(path.join(root, 'scripts/windows-app-checks.ps1')));
  await writePrivateFile(path.join(bundle, 'README.md'), await fs.readFile(path.join(root, 'docs/application-cli.md')));
  for (const name of CLIENT_IDENTITY_FILES) await writePrivateFile(path.join(bundle, 'client-pair', name), await fs.readFile(path.join(pairingDirectory, name)));
  await writePrivateFile(path.join(bundle, 'bundle.json'), JSON.stringify({ transport: 'app-tls', mode: 'mock',
    filename: release.filename, version: release.version, sha256: release.sha256 }, null, 2));
  const archive = path.join(release.directory, 'hai-app-cli-checks.tgz');
  await execute('tar', ['-czf', archive, '-C', release.directory, 'hai-app-cli-checks'], { timeout: 30000 });
  await fs.chmod(archive, 0o600);
  const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await writePrivateFile(path.join(release.directory, 'APP-SHA256SUMS'), sha256 + '  hai-app-cli-checks.tgz' + String.fromCharCode(10));
  return { archive, sha256, directory: release.directory, version: release.version };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'pairing-dir': { type: 'string' } } });
  buildApplicationDelivery({ pairingDirectory: values['pairing-dir'] }).then(value => console.log(JSON.stringify(value, null, 2))).catch(() => {
    console.error('Private mock application delivery failed; check B pairing, npm allowlist and output permissions. Nothing was published.');
    process.exitCode = 1;
  });
}
