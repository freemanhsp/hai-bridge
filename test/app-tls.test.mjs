import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generatePair, loadPair, SERVER_NAME } from '../explore/2026-11-20-app-tls/certificates.mjs';
import { startMockPublisher, startMockClient, startOpaqueRelay, clientTlsOptions, listen, closeServer } from '../explore/2026-11-20-app-tls/transport.mjs';
import { runChecks, request, portFree } from '../explore/2026-11-20-app-tls/checks.mjs';
import { experimentalSshArguments } from '../explore/2026-11-20-app-tls/ssh.mjs';
import { prepareBundle, BUNDLE_FILES } from '../explore/2026-11-20-app-tls/prepare.mjs';
import { sshArguments } from '../src/tunnel.mjs';
import { DEV_TOKEN } from '../src/dev.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
let temporary, directory, serverPair, clientPair;
before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-app-tls-tests-'));
  directory = await generatePair(temporary);
  serverPair = await loadPair(directory, 'server');
  clientPair = await loadPair(directory, 'client');
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

test('generated pair has distinct pinned identities, short validity and no retained CA signing key', async () => {
  assert.notEqual(serverPair.server_pin, serverPair.client_pin);
  assert.equal(clientPair.server_name, SERVER_NAME);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['ca.pem', 'client.key', 'client.pem', 'pair.json', 'server.key', 'server.pem']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, 'server.key'))).mode & 0o777, 0o600);
  await assert.rejects(loadPair(directory, 'wrong'), /role/);
  assert.throws(() => clientTlsOptions({ ...clientPair, server_pin: '' }), /trust/);
});

test('real mTLS through opaque TCP passes the cross-device batch with cancellation and bounded recovery', { timeout: 30000 }, async t => {
  const publisher = await startMockPublisher(serverPair);
  let relay = await startOpaqueRelay(publisher.port, { capture: true });
  const initial = relay, tlsPort = relay.port;
  t.after(async () => { await relay.close(); await publisher.close(); });
  const report = await runChecks(clientPair, tlsPort, { interrupt: () => relay.close(),
    restore: async () => { if (!relay.server.listening) relay = await startOpaqueRelay(publisher.port, { port: tlsPort }); } });
  assert.equal(report.status, 'pass', JSON.stringify(report));
  assert.equal(report.checks.length, 19);
  assert.equal(publisher.stats.activeStreams, 0);
  const wire = Buffer.concat(initial.captured);
  assert.ok(wire.length > 1000);
  for (const plaintext of [DEV_TOKEN, '/openai/v1/responses', 'relay-ok', 'response.output_text.delta', ' 中文']) {
    assert.equal(wire.includes(Buffer.from(plaintext)), false, 'Opaque relay must not see application plaintext');
  }
  assert.equal(JSON.stringify(report).includes(DEV_TOKEN), false);
});

test('wrong pinned B identity is rejected at A without any mock upstream access', async t => {
  const publisher = await startMockPublisher({ ...serverPair, client_pin: '0'.repeat(64) });
  t.after(() => publisher.close());
  await assert.rejects(request('https://127.0.0.1:' + publisher.port, '/openai/v1/models', { security: clientTlsOptions(clientPair) }));
  assert.equal(publisher.stats.requests, 0);
});

test('untrusted client and wrong client certificate purpose fail closed', async t => {
  const publisher = await startMockPublisher(serverPair);
  const other = await loadPair(await generatePair(temporary), 'client');
  t.after(() => publisher.close());
  for (const invalid of [{ ...clientPair, cert: other.cert, key: other.key },
    { ...clientPair, cert: serverPair.cert, key: serverPair.key }]) {
    await assert.rejects(request('https://127.0.0.1:' + publisher.port, '/openai/v1/models', { security: clientTlsOptions(invalid) }));
  }
  assert.equal(publisher.stats.requests, 0);
});

test('MITM TLS server without A identity fails before receiving an HTTP request', async t => {
  let requests = 0;
  const impostor = https.createServer({ cert: clientPair.cert, key: clientPair.key }, (req, res) => { requests++; res.end('mock'); });
  const tlsPort = await listen(impostor);
  const client = await startMockClient(clientPair, { tlsPort });
  t.after(async () => { await client.close(); await closeServer(impostor); });
  const reply = await request(client.origin, '/openai/v1/models', { headers: { authorization: 'Bearer ' + DEV_TOKEN } });
  assert.equal(reply.status, 502);
  assert.equal(requests, 0);
});

test('occupied client/application ports are not replaced or closed', async t => {
  const publisher = await startMockPublisher(serverPair);
  const client = await startMockClient(clientPair, { tlsPort: publisher.port });
  t.after(async () => { await client.close(); await publisher.close(); });
  await assert.rejects(startMockClient(clientPair, { tlsPort: publisher.port, port: client.port }), { code: 'EADDRINUSE' });
  await assert.rejects(startMockPublisher(serverPair, { port: publisher.port }), { code: 'EADDRINUSE' });
  assert.equal((await request(client.origin, '/openai/v1/models', { headers: { authorization: 'Bearer ' + DEV_TOKEN } })).status, 200);
});

test('experimental SSH uses only ECS login and loopback TLS forwarding; legacy Mac22 guard is unchanged', () => {
  const options = { target: 'mock@ecs.example', identity: '/tmp/mock-key', knownHosts: '/tmp/mock-known', relayPort: 18083, appPort: 18081, tunnelPort: 18085 };
  const a = experimentalSshArguments({ ...options, direction: 'publish' });
  const b = experimentalSshArguments({ ...options, direction: 'connect' });
  assert.equal(a[a.indexOf('-R') + 1], '127.0.0.1:18083:127.0.0.1:18081');
  assert.equal(b[b.indexOf('-L') + 1], '127.0.0.1:18085:127.0.0.1:18083');
  for (const args of [a, b]) {
    assert.ok(args.includes('StrictHostKeyChecking=yes') && args.includes('ForwardAgent=no'));
    assert.ok(args.includes('-F'));
    assert.equal(args.some(arg => arg.includes('ProxyJump') || arg.includes('ProxyCommand')), false);
    assert.equal(args.at(-1), 'mock@ecs.example');
  }
  assert.throws(() => experimentalSshArguments({ ...options, direction: 'connect', knownHosts: undefined }), /trust/);
  assert.throws(() => experimentalSshArguments({ ...options, direction: 'publish', appPort: 0 }), /port/);
  assert.throws(() => sshArguments({ direction: 'remote', target: 'mock@ecs.example', localPort: 18083, remoteHost: '127.0.0.1', remotePort: 18081 }), /22/);
});

test('B tarball has exact allowlist and only B TLS identity; extracted code can load it without OpenSSL', { timeout: 30000 }, async t => {
  const release = await prepareBundle({ outputRoot: temporary });
  const { stdout } = await execute('tar', ['-tzf', release.archive]);
  const files = stdout.trim().split(String.fromCharCode(10)).filter(f => !f.endsWith('/')).map(f => f.replace('hai-app-tls-checks/', '')).sort();
  const expected = [...BUNDLE_FILES, 'README.md', 'windows-checks.ps1', 'client/client.key', 'client/client.pem', 'client/ca.pem', 'client/pair.json'].sort();
  assert.deepEqual(files, expected);
  assert.equal(files.some(f => f.includes('server.key') || f.includes('ca.key') || f.includes('mydocs') || f.includes('auth.json')), false);
  const extracted = await fs.mkdtemp(path.join(temporary, 'extracted-'));
  await execute('tar', ['-xzf', release.archive, '-C', extracted]);
  const bundle = path.join(extracted, 'hai-app-tls-checks');
  const loaded = await execute(process.execPath, ['--input-type=module', '-e',
    'const {loadPair}=await import("./explore/2026-11-20-app-tls/certificates.mjs"); await loadPair("./client","client"); console.log("ok")'], { cwd: bundle });
  assert.equal(loaded.stdout.trim(), 'ok');
  const publisher = await startMockPublisher(await loadPair(release.directory, 'server'));
  t.after(() => publisher.close());
  const pairing = await loadPair(path.join(bundle, 'client'), 'client');
  const client = await startMockClient(pairing, { tlsPort: publisher.port });
  t.after(() => client.close());
  assert.equal((await request(client.origin, '/healthz', { headers: { authorization: 'Bearer ' + DEV_TOKEN } })).status, 200);
});

test('local CLI returns safe report and refuses existing report before starting', { timeout: 30000 }, async () => {
  const out = path.join(temporary, 'report.json');
  const cli = path.join(root, 'explore/2026-11-20-app-tls/run.mjs');
  const { stdout, stderr } = await execute(process.execPath, [cli, 'local', '--out', out], {
    timeout: 25000, env: { ...process.env, HAI_BRIDGE_TOKEN: 'SYNTHETIC-POISON', HAI_UPSTREAM_API_KEY: 'SYNTHETIC-POISON' } });
  assert.equal(stderr, '');
  assert.equal(stdout.includes('SYNTHETIC-POISON'), false);
  const bytes = await fs.readFile(out, 'utf8');
  const report = JSON.parse(bytes);
  assert.equal(report.status, 'pass');
  assert.equal(report.hai, 'not_called');
  assert.equal(report.evidence, 'local-real-tls-opaque-tcp');
  await assert.rejects(execute(process.execPath, [cli, 'local', '--out', out]));
  assert.equal(await fs.readFile(out, 'utf8'), bytes);
  for (const check of report.checks) assert.equal(check.status, 'pass');
  await portFree(18085);
});
