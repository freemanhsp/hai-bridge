import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeServer, loadServerConfig, exportClient, loadClientConfig, credentialReaders,
  writePrivateFile, loopbackUrl } from '../src/config.mjs';
import { codexArguments } from '../src/client.mjs';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-bridge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('pairing exports only the bridge token, refuses overwrites, and rereads rotated HAI credentials', async t => {
  const dir = await directory(t);
  const serverFile = path.join(dir, 'server.json'), authFile = path.join(dir, 'auth.json');
  await writePrivateFile(authFile, JSON.stringify({ OPENAI_API_KEY: 'first-hai-key', tokens: { refresh_token: 'NOT-EXPORTED' } }));
  await initializeServer(serverFile, { upstreamAuthFile: authFile });
  const config = await loadServerConfig(serverFile);
  const readers = credentialReaders(config, {});
  assert.equal(await readers.getUpstreamKey(), 'first-hai-key');
  const out = path.join(dir, 'client.json');
  await exportClient(serverFile, out, { sshTarget: 'user@mac.local' });
  const client = await loadClientConfig(out, {});
  assert.equal(client.token, await readers.getBridgeToken());
  const pairing = await fs.readFile(out, 'utf8');
  assert.equal(pairing.includes('first-hai-key'), false);
  assert.equal(pairing.includes('NOT-EXPORTED'), false);
  await assert.rejects(initializeServer(serverFile), /already exists/);
  await assert.rejects(exportClient(serverFile, out, { sshTarget: 'user@mac.local' }), { code: 'EEXIST' });
  await fs.writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: 'rotated-hai-key' }));
  assert.equal(await readers.getUpstreamKey(), 'rotated-hai-key');
  await fs.writeFile(config.tokenFile, 'r'.repeat(43));
  assert.equal(await readers.getBridgeToken(), 'r'.repeat(43));
  if (process.platform !== 'win32') assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
});

test('configuration refuses remote/credential-bearing upstreams and public listeners', async t => {
  for (const url of ['https://127.0.0.1:6655', 'http://example.com', 'http://user:secret@localhost',
    'http://localhost/path', 'http://localhost?token=secret']) assert.throws(() => loopbackUrl(url));
  const dir = await directory(t), file = path.join(dir, 'server.json');
  await initializeServer(file);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.listen_host = '0.0.0.0';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(loadServerConfig(file), /must listen/);
});

test('Codex receives the bridge token via environment, never via command arguments', () => {
  const token = 's'.repeat(43);
  const args = codexArguments({ model: 'gpt-6-luna', token }, 'http://127.0.0.1:16655', ['exec', 'literal $() & prompt']);
  assert.equal(args.some(value => value.includes(token)), false);
  assert.equal(args.includes('model_providers.hai-bridge.env_key="HAI_BRIDGE_TOKEN"'), true);
  assert.equal(args.includes('model_providers.hai-bridge.requires_openai_auth=false'), true);
  assert.equal(args.includes('model_providers.hai-bridge.supports_websockets=false'), true);
  assert.equal(args.at(-1), 'literal $() & prompt');
  assert.equal(args[0], '--no-daemon');
  assert.equal(args[1], 'exec');
  assert.equal(args[2], '-c');
  const nonDaemon = codexArguments({ model: 'gpt-6-luna', token }, 'http://127.0.0.1:16655', ['--no-daemon', 'exec', '--ignore-user-config', 'hello']);
  assert.deepEqual(nonDaemon.slice(0, 3), ['--no-daemon', 'exec', '-c']);
  assert.equal(nonDaemon.filter(value => value === '--no-daemon').length, 1);
});
