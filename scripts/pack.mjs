import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const allowed = /^(package[.]json|README[.]md|bin\/hai-bridge[.]mjs|src\/[A-Za-z0-9_-]+[.]mjs|docs\/[A-Za-z0-9_-]+[.]md)$/;

export function validatePackedFiles(files) {
  if (!Array.isArray(files) || files.some(file => !allowed.test(file.path))) {
    throw new Error('Package contains files outside the runtime/documentation allowlist');
  }
  for (const required of ['package.json', 'README.md', 'bin/hai-bridge.mjs', 'src/version.mjs', 'src/dev.mjs']) {
    if (!files.some(file => file.path === required)) throw new Error('Package is missing a required runtime file');
  }
}

export async function buildRelease({ root = sourceRoot, outputRoot = path.join(root, '.local', 'artifacts'),
  npmCli = process.env.npm_execpath } = {}) {
  if (typeof npmCli !== 'string' || !path.isAbsolute(npmCli)) throw new Error('Run packaging through npm run pack');
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'hai-bridge' || metadata.private !== true || !/^\d+[.]\d+[.]\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) {
    throw new Error('Expected a private hai-bridge package with a valid version');
  }
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-bridge-pack-cache-'));
  try {
    const pack = async (extra = []) => {
      const { stdout } = await execute(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts',
        '--workspaces=false', '--json', '--cache', cache, ...extra], { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      const result = JSON.parse(stdout);
      if (result.length !== 1 || result[0].name !== metadata.name || result[0].version !== metadata.version) {
        throw new Error('Unexpected npm package metadata');
      }
      validatePackedFiles(result[0].files);
      return result[0];
    };
    // Inspect before writing an archive; lifecycle scripts and remote fetches stay disabled.
    await pack(['--dry-run']);
    await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(outputRoot, 'hai-bridge-' + metadata.version + '-'));
    const packed = await pack(['--pack-destination', directory]);
    const filename = 'hai-bridge-' + metadata.version + '.tgz';
    if (packed.filename !== filename) throw new Error('Unexpected npm archive filename');
    const archive = path.join(directory, filename);
    const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    let gitCommit, gitDirty;
    try {
      const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000 });
      if (/^[a-f0-9]{40}$/.test(stdout.trim())) gitCommit = stdout.trim();
      const status = await execute('git', ['status', '--porcelain'], { cwd: root, timeout: 5000 });
      gitDirty = status.stdout.trim().length > 0;
    } catch {}
    const release = { name: metadata.name, version: metadata.version, filename, sha256,
      node_required: metadata.engines.node, git_commit: gitCommit, git_dirty: gitDirty, files: packed.files.map(file => file.path) };
    await fs.writeFile(path.join(directory, 'SHA256SUMS'), sha256 + '  ' + filename + '\n', { flag: 'wx', mode: 0o600 });
    // This file marks a completed build; incomplete directories are never advertised as releases.
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ...release, directory, archive };
  } finally {
    // This cache was created by this invocation and contains no project/user files.
    await fs.rm(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRelease().then(release => console.log(JSON.stringify(release, null, 2))).catch(() => {
    console.error('HAI Bridge: local packaging failed; check npm/Node, file allowlist and output permissions. No package was published.');
    process.exitCode = 1;
  });
}
