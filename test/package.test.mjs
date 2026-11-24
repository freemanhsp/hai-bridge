import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRelease, validatePackedFiles } from '../scripts/pack.mjs';
import { PACKAGE_NAME, VERSION, versionInfo } from '../src/version.mjs';
import { formatDevelopmentReady } from '../src/dev.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin', 'hai-bridge.mjs');
const npmCli = process.env.npm_execpath;
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-package-tests-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function sourceFixture(t) {
  const directory = await temporary(t);
  for (const file of ['package.json', 'README.md', 'bin', 'src', 'docs']) {
    await fs.cp(path.join(root, file), path.join(directory, file), { recursive: true });
  }
  return directory;
}

test('version comes from package metadata and works without config from unrelated cwd', async t => {
  const cwd = await temporary(t);
  await fs.writeFile(path.join(cwd, 'package.json'), '{"name":"wrong-cwd-package","version":"99.0.0"}');
  const env = { ...process.env, HAI_BRIDGE_TOKEN: 'SYNTHETIC-POISON', HAI_UPSTREAM_API_KEY: 'SYNTHETIC-POISON' };
  for (const command of ['version', '--version', '-v']) {
    const { stdout, stderr } = await execute(process.execPath, [cli, command], { cwd, env });
    assert.equal(stdout.trim(), PACKAGE_NAME + ' ' + VERSION);
    assert.equal(stderr, '');
  }
  const { stdout } = await execute(process.execPath, [cli, 'version', '--json'], { cwd, env });
  assert.deepEqual(JSON.parse(stdout), versionInfo());
  assert.equal(stdout.includes('SYNTHETIC-POISON'), false);
  await assert.rejects(execute(process.execPath, [cli, '--version', '--client-config', 'DO-NOT-READ']), /Unknown option/);
  await assert.rejects(execute(process.execPath, [cli, 'version', 'extra']), /Unexpected argument/);
  assert.deepEqual((await fs.readdir(cwd)).sort(), ['package.json']);
});

test('pack allowlist rejects unexpected files and missing runtime entrypoints', () => {
  const required = ['package.json', 'README.md', 'bin/hai-bridge.mjs', 'src/version.mjs', 'src/dev.mjs'].map(path => ({ path }));
  validatePackedFiles(required);
  for (const path of ['.local/client.json', 'mydocs/note.md', 'explore/test.mjs', 'test/dev.test.mjs',
    'scripts/pack.mjs', '.env', 'src/.secret.mjs', 'src/private.key', '../src/version.mjs']) {
    assert.throws(() => validatePackedFiles([...required, { path }]), /outside/);
  }
  assert.throws(() => validatePackedFiles(required.slice(1)), /missing/);
  assert.throws(() => validatePackedFiles(null), /outside/);
});

test('pack validates private identity and refuses unexpected npm auto-included files before an archive', { timeout: 30000 }, async t => {
  const directory = await sourceFixture(t), outputRoot = path.join(directory, '.local', 'artifacts');
  await assert.rejects(buildRelease({ root: directory, npmCli: '' }), /npm run pack/);
  await fs.writeFile(path.join(directory, 'LICENSE'), 'SYNTHETIC-UNAPPROVED-FILE');
  await assert.rejects(buildRelease({ root: directory, outputRoot, npmCli }), /outside/);
  await assert.rejects(fs.access(outputRoot), { code: 'ENOENT' });
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  metadata.private = false;
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(metadata));
  await assert.rejects(buildRelease({ root: directory, outputRoot, npmCli }), /private hai-bridge/);
});

test('actual offline pack excludes private assets, supplies SHA-256 and preserves earlier releases', { timeout: 60000 }, async t => {
  const directory = await sourceFixture(t), outputRoot = path.join(directory, '.local', 'artifacts');
  for (const filename of ['.local/client.json', 'mydocs/private.md', 'explore/mock.mjs', 'test/private.mjs', '.env']) {
    const file = path.join(directory, filename);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'SYNTHETIC-EXCLUDED-NEVER-SHIP');
  }
  // npm lifecycle scripts must not execute, even in a modified source tree.
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  metadata.scripts.prepare = 'node -e "process.exit(91)"';
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(metadata));
  await assert.rejects(buildRelease({ root: directory, outputRoot, npmCli }), /Lifecycle scripts are not allowed/);
  delete metadata.scripts.prepare;
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(metadata));
  const first = await buildRelease({ root: directory, outputRoot, npmCli });
  const bytes = await fs.readFile(first.archive);
  assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(await fs.readFile(path.join(first.directory, 'SHA256SUMS'), 'utf8'), first.sha256 + '  ' + first.filename + '\n');
  const release = JSON.parse(await fs.readFile(path.join(first.directory, 'release.json'), 'utf8'));
  assert.equal(release.name, 'hai-bridge');
  assert.equal(release.version, VERSION);
  assert.equal(release.node_required, '>=22');
  assert.ok(release.files.includes('src/bridge.mjs'));
  assert.equal(release.files.some(file => /^([.]|mydocs|test|explore|scripts)/.test(file)), false);
  const second = await buildRelease({ root: directory, outputRoot, npmCli });
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(await fs.readFile(first.archive), bytes);
  assert.equal(await fs.readFile(path.join(directory, '.local', 'client.json'), 'utf8'), 'SYNTHETIC-EXCLUDED-NEVER-SHIP');
});

test('all pack/install lifecycle hooks are refused before invoking even a missing npm CLI', async t => {
  const directory = await sourceFixture(t), outputRoot = path.join(directory, '.local', 'artifacts');
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  for (const hook of ['prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly',
    'preinstall', 'install', 'postinstall']) {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...metadata,
      scripts: { ...metadata.scripts, [hook]: 'node -e "process.exit(91)"' } }));
    await assert.rejects(buildRelease({ root: directory, outputRoot, npmCli: path.join(directory, 'missing-npm.mjs') }), /Lifecycle scripts are not allowed/);
    await assert.rejects(fs.access(outputRoot), { code: 'ENOENT' });
  }
});

test('installed commands quote Node/entry/config paths for POSIX and PowerShell', () => {
  const service = { origin: 'http://127.0.0.1:1', clientFile: "/tmp/cfg' $(NOT-RUN)/client.json", temporary: true };
  const options = { executable: "/opt/Node Space/node'", cli: "/tmp/install' $(NOT-RUN)/bin/hai-bridge.mjs" };
  const posix = formatDevelopmentReady(service, 'darwin', options);
  const windows = formatDevelopmentReady(service, 'win32', options);
  assert.ok(posix.includes("'/opt/Node Space/node'\"'\"'' '/tmp/install'\"'\"' $(NOT-RUN)/bin/hai-bridge.mjs' doctor"));
  assert.ok(windows.includes("& '/opt/Node Space/node''' '/tmp/install'' $(NOT-RUN)/bin/hai-bridge.mjs' doctor"));
});

test('actual tarball installs offline into isolated prefix and its bin runs away from source', { timeout: 60000 }, async t => {
  const directory = await temporary(t);
  const release = await buildRelease({ outputRoot: path.join(directory, 'artifacts'), npmCli });
  const prefix = path.join(directory, "install space's"), cwd = path.join(directory, 'unrelated');
  await fs.mkdir(cwd);
  await execute(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--cache', path.join(directory, 'npm-cache'), release.archive], { cwd, timeout: 30000 });
  const packageRoot = process.platform === 'win32' ? path.join(prefix, 'node_modules', 'hai-bridge')
    : path.join(prefix, 'lib', 'node_modules', 'hai-bridge');
  const installedCli = path.join(packageRoot, 'bin', 'hai-bridge.mjs');
  const shim = process.platform === 'win32' ? path.join(prefix, 'hai-bridge.cmd') : path.join(prefix, 'bin', 'hai-bridge');
  await fs.access(shim);
  const output = await execute(process.execPath, [installedCli, '--version'], { cwd });
  assert.equal(output.stdout.trim(), 'hai-bridge ' + VERSION);
  const { stdout: help } = await execute(process.execPath, [installedCli, '--help'], { cwd });
  assert.match(help, /Default configuration paths are relative/);
  assert.equal((await fs.readdir(cwd)).length, 0);
  if (process.platform !== 'win32') {
    const { stdout } = await execute(shim, ['--version'], { cwd });
    assert.equal(stdout.trim(), 'hai-bridge ' + VERSION);
  }
});

test('installed dev prints working commands from unrelated cwd and cleans up after SIGTERM',
  { timeout: 60000, skip: process.platform === 'win32' }, async t => {
    const directory = await temporary(t), prefix = path.join(directory, "prefix with space's"), cwd = path.join(directory, 'work');
    const release = await buildRelease({ outputRoot: path.join(directory, 'artifacts'), npmCli });
    await fs.mkdir(cwd);
    await execute(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts',
      '--no-audit', '--no-fund', '--cache', path.join(directory, 'npm-cache'), release.archive], { timeout: 30000 });
    const shim = path.join(prefix, 'bin', 'hai-bridge');
    const child = spawn(shim, ['dev', '--port', '0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const exit = new Promise(resolve => child.once('close', code => resolve(code)));
    t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exit; });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error('installed dev exited before ready')));
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.includes('Ctrl-C stops both owned servers.')) resolve(); });
    });
    const lines = stdout.trim().split('\n');
    const commands = lines.filter(line => line.includes(' doctor --client-config ') || line.includes(' probe --client-config '));
    assert.equal(commands.length, 2);
    const env = { ...process.env, HAI_BRIDGE_TOKEN: '', HAI_UPSTREAM_API_KEY: '' };
    const doctor = JSON.parse((await execute('/bin/sh', ['-c', commands[0]], { cwd, env })).stdout);
    assert.equal(doctor.mock, true);
    assert.equal(doctor.hai, 'not_checked');
    const probe = JSON.parse((await execute('/bin/sh', ['-c', commands[1]], { cwd, env })).stdout);
    assert.equal(probe.completed, true);
    assert.equal(probe.input_tokens, 0);
    assert.equal(probe.output_tokens, 0);
    const configFile = lines.find(line => line.startsWith('Temporary client config: ')).slice('Temporary client config: '.length);
    child.kill('SIGTERM');
    assert.equal(await exit, 0);
    assert.equal(stderr, '');
    await assert.rejects(fs.access(configFile), { code: 'ENOENT' });
    assert.equal((await fs.readdir(cwd)).length, 0);
  });
