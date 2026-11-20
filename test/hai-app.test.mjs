import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeApplicationPublisher, initializeApplicationClient, loadApplicationConfig, loadApplicationAccess,
  applicationCredentialReaders, loadToolClient } from '../src/app-config.mjs';
import { loadPair, HAI_SERVER_NAME } from '../src/app-identity.mjs';
import { startHaiPublisher, startHaiClient, startMockPublisher, startMockClient, closeServer, listen } from '../src/app-transport.mjs';
import { applicationSshArguments, assertPortFree } from '../src/app-runtime.mjs';
import { checkApplicationClient } from '../src/app-checks.mjs';
import { tryHai } from '../src/hai-trial.mjs';
import { buildApplicationDelivery } from '../scripts/pack-app-checks.mjs';
import { DEV_TOKEN } from '../src/dev.mjs';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const SYNTHETIC_KEY = 'synthetic-HAI-key-local-tests-only';
let temporary, sshKey, knownHosts, authFile, upstream, serverInfo, mockInfo, currentKey, postStatus = 200;
const requests = [];
before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-real-mode-tests-'));
  sshKey = path.join(temporary, 'synthetic-ssh-key'); knownHosts = path.join(temporary, 'synthetic-known-hosts');
  authFile = path.join(temporary, 'synthetic-auth.json'); currentKey = SYNTHETIC_KEY;
  await fs.writeFile(sshKey, 'synthetic-not-an-SSH-key', { mode: 0o600 });
  await fs.writeFile(knownHosts, '# synthetic trust', { mode: 0o600 });
  await fs.writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: currentKey }), { mode: 0o600 });
  upstream = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'], googleKey: req.headers['x-goog-api-key'] });
    if (req.headers.authorization !== 'Bearer ' + currentKey) { req.resume(); res.writeHead(401).end(); return; }
    req.resume();
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
    } else if (postStatus !== 200) {
      res.writeHead(postStatus, { 'content-type': 'application/json', 'retry-after': '7' }).end('{"error":{"code":"synthetic_failure"}}');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.output_text.delta","delta":"SYNTHETIC-PRIVATE-OUTPUT 中文"}\n\n');
      res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n');
    }
  });
  const upstreamPort = await listen(upstream);
  serverInfo = await initializeApplicationPublisher(path.join(temporary, 'real-a'), {
    hai: true, upstreamUrl: 'http://127.0.0.1:' + upstreamPort, upstreamAuthFile: authFile, model: 'synthetic-model',
    sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: knownHosts });
  mockInfo = await initializeApplicationPublisher(path.join(temporary, 'mock-a'), {
    mock: true, sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: knownHosts });
});
after(async () => { await closeServer(upstream); if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

async function unusedPort() { const s = net.createServer(); const port = await listen(s); await closeServer(s); return port; }
async function client(name) {
  const file = path.join(temporary, name + '.json');
  await initializeApplicationClient(file, { hai: true, sshTarget: 'test@ecs.example', identityFile: sshKey,
    knownHostsFile: knownHosts, pairingDirectory: serverInfo.clientDirectory, localPort: await unusedPort(), tunnelPort: await unusedPort() });
  return { file, config: await loadApplicationConfig(file, 'client') };
}
async function publisher(t) {
  const config = await loadApplicationConfig(serverInfo.serverFile, 'publisher');
  const p = await startHaiPublisher(config.pair, { config }); t.after(() => p.close()); return p;
}
function tcpHarness(targetPort) {
  const children = [];
  return { children, spawnProcess(command, args, options) {
    assert.equal(options.shell, false); assert.equal(args.some(a => a.includes(SYNTHETIC_KEY)), false);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child);
    const sockets = new Set(), port = Number(args[args.indexOf('-L') + 1].split(':')[1]);
    const server = net.createServer(incoming => {
      const outgoing = net.connect(targetPort, '127.0.0.1');
      for (const s of [incoming, outgoing]) {
        sockets.add(s); s.on('error', () => { incoming.destroy(); outgoing.destroy(); });
        s.once('close', () => { sockets.delete(s); incoming.destroy(); outgoing.destroy(); });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    let stopped = false;
    child.kill = () => {
      if (stopped) return true; stopped = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => child.emit('close', null)); return true;
    };
    server.listen(port, '127.0.0.1');
    return child;
  } };
}

test('explicit HAI initialization creates distinct identity and a B-only private access file', async () => {
  const a = await loadApplicationConfig(serverInfo.serverFile, 'publisher'), { file, config: b } = await client('initialization');
  assert.equal(a.mode, 'hai'); assert.equal(b.mode, 'hai'); assert.equal(b.pair.server_name, HAI_SERVER_NAME);
  assert.notEqual(a.token, DEV_TOKEN); assert.equal(a.token, b.token); assert.equal(b.model, 'synthetic-model');
  assert.deepEqual((await fs.readdir(serverInfo.clientDirectory)).sort(), ['access.json', 'ca.pem', 'client.key', 'client.pem', 'pair.json']);
  const rawB = JSON.parse(await fs.readFile(file));
  assert.equal(rawB.upstream_url, undefined); assert.equal(rawB.upstream_auth_file, undefined);
  assert.equal(JSON.stringify(rawB).includes(SYNTHETIC_KEY), false);
  assert.equal((await loadToolClient(file, { HAI_BRIDGE_TOKEN: DEV_TOKEN, HAI_UPSTREAM_API_KEY: 'poison' })).token, b.token);
  assert.equal(applicationSshArguments(a).includes('-R'), true);
});

test('real and mock pairings cannot be interchanged or enabled by flipping config mode', async () => {
  await assert.rejects(loadPair(serverInfo.directory, 'server'));
  await assert.rejects(loadPair(mockInfo.directory, 'server', { mode: 'hai' }));
  const mock = JSON.parse(await fs.readFile(mockInfo.serverFile));
  const changed = path.join(mockInfo.directory, 'changed.json');
  await fs.writeFile(changed, JSON.stringify({ ...mock, mode: 'hai', upstream_url: 'http://127.0.0.1:6655', upstream_auth_file: authFile }));
  await assert.rejects(loadApplicationConfig(changed, 'publisher'), /pairing/);
  const pair = await loadPair(serverInfo.directory, 'client', { mode: 'hai' });
  await assert.rejects(startMockClient(pair, { tlsPort: 12345 }));
  await assert.rejects(startMockPublisher(await loadPair(serverInfo.directory, 'server', { mode: 'hai' })));
  await assert.rejects(startHaiClient(pair, { tlsPort: 12345, token: DEV_TOKEN }));
});

test('HAI init requires explicit upstream/auth/model and rejects public/credential/path origins before creating assets', async () => {
  const options = { hai: true, model: 'synthetic-model', upstreamAuthFile: authFile, sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: knownHosts };
  for (const upstreamUrl of [undefined, 'http://ecs.example:6655', 'http://127.0.0.1:6655/openai/v1', 'http://key@127.0.0.1:6655', 'https://127.0.0.1:6655']) {
    await assert.rejects(initializeApplicationPublisher(path.join(temporary, 'must-not-exist'), { ...options, upstreamUrl }));
  }
  await assert.rejects(fs.access(path.join(temporary, 'must-not-exist')), { code: 'ENOENT' });
  await assert.rejects(initializeApplicationPublisher(path.join(temporary, 'both-modes'), { ...options, mock: true }));
});

test('B access metadata cannot smuggle A credentials or an invalid token/model', async () => {
  const { config } = await client('access-validation');
  const file = path.join(config.tlsDirectory, 'access.json'), original = JSON.parse(await fs.readFile(file));
  for (const change of [{ upstream_key: SYNTHETIC_KEY }, { bridge_token: 'short' }, { bridge_token: DEV_TOKEN }, { model: 'bad;model' }, { mode: 'mock' }]) {
    await fs.writeFile(file, JSON.stringify({ ...original, ...change }));
    await assert.rejects(loadApplicationAccess(config.tlsDirectory));
  }
  await fs.writeFile(file, JSON.stringify(original));
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o644); await assert.rejects(loadApplicationAccess(config.tlsDirectory)); await fs.chmod(file, 0o600);
  }
});

test('real TLS adapter replaces B credentials only at A, retains Unicode SSE, and wrong token never reaches upstream', async t => {
  const a = await publisher(t), { config } = await client('http');
  const b = await startHaiClient(config.pair, { token: config.token, tlsPort: a.port }); t.after(() => b.close());
  const count = requests.length;
  assert.equal((await fetch(b.origin + '/openai/v1/models', { headers: { Authorization: 'Bearer ' + DEV_TOKEN } })).status, 401);
  assert.equal(requests.length, count);
  const response = await fetch(b.origin + '/openai/v1/responses', { method: 'POST',
    headers: { Authorization: 'Bearer ' + config.token, 'x-api-key': 'synthetic-B-key', 'x-goog-api-key': 'synthetic-B-google-key' }, body: '{}' });
  assert.equal(response.status, 200); assert.match(await response.text(), /中文/);
  const last = requests.at(-1);
  assert.equal(last.authorization, 'Bearer ' + SYNTHETIC_KEY); assert.equal(last.apiKey, undefined); assert.equal(last.googleKey, undefined);
  const before = requests.length;
  assert.equal((await fetch(b.origin + '/admin', { headers: { Authorization: 'Bearer ' + config.token } })).status, 404);
  assert.equal(requests.length, before);
});

test('A reads its explicit authentication file per request without environment overrides and fails closed on bad auth', async () => {
  const a = await loadApplicationConfig(serverInfo.serverFile, 'publisher'), readers = applicationCredentialReaders(a);
  await fs.writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: 'synthetic-rotated-key' }));
  assert.equal(await readers.getUpstreamKey(), 'synthetic-rotated-key');
  await fs.writeFile(authFile, '{bad');
  await assert.rejects(readers.getUpstreamKey(), error => !error.message.includes(SYNTHETIC_KEY));
  await fs.writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: SYNTHETIC_KEY }));
});

test('try-hai defaults to model-only and releases its owned B ports without sending POST', async t => {
  const a = await publisher(t), { file, config } = await client('models-only'), h = tcpHarness(a.port);
  const count = requests.filter(r => r.method === 'POST').length;
  const result = await tryHai({ clientFile: file, out: path.join(temporary, 'models-report.json') }, {
    runtimeOptions: { spawnProcess: h.spawnProcess }, evidence: 'local-synthetic-HAI-TLS-TCP-stub-not-real-HAI' });
  assert.equal(result.report.status, 'models-only'); assert.equal(result.report.inference, 'not_requested');
  assert.equal(requests.filter(r => r.method === 'POST').length, count);
  assert.equal(h.children.length, 1); await assertPortFree(config.localPort); await assertPortFree(config.tunnelPort);
});

test('opt-in real-mode trial uses one synthetic POST, writes only safe summary and protects output', async t => {
  const a = await publisher(t), { file, config } = await client('trial'), h = tcpHarness(a.port), events = [];
  const out = path.join(temporary, 'trial-report.json'), before = requests.filter(r => r.method === 'POST').length;
  const result = await tryHai({ clientFile: file, out, infer: true }, { runtimeOptions: { spawnProcess: h.spawnProcess },
    onEvent: event => events.push(event), evidence: 'local-synthetic-HAI-TLS-TCP-stub-not-real-HAI' });
  assert.equal(result.report.status, 'pass'); assert.equal(result.report.inference, 'completed');
  assert.equal(requests.filter(r => r.method === 'POST').length, before + 1);
  assert.deepEqual(result.report.usage, { input_tokens: 3, output_tokens: 2 });
  for (const secret of [SYNTHETIC_KEY, config.token, 'SYNTHETIC-PRIVATE-OUTPUT', 'Reply only with OK.']) {
    assert.equal(JSON.stringify(result.report).includes(secret), false); assert.equal(JSON.stringify(events).includes(secret), false);
  }
  assert.ok(events.some(e => e.event === 'application' && e.mock === false && e.hai === 'enabled'));
  await assert.rejects(tryHai({ clientFile: file, out, infer: true }), { code: 'EEXIST' });
});

test('429/503 trial failures do not retry POST or invent completion', async t => {
  const a = await publisher(t);
  for (const status of [429, 503]) {
    const { file } = await client('error-' + status), h = tcpHarness(a.port);
    const count = requests.filter(r => r.method === 'POST').length; postStatus = status;
    try {
      const result = await tryHai({ clientFile: file, out: path.join(temporary, 'error-report-' + status + '.json'), infer: true }, {
        runtimeOptions: { spawnProcess: h.spawnProcess }, evidence: 'local-synthetic-HAI' });
      assert.equal(result.report.status, 'fail'); assert.equal(result.report.inference, 'attempted');
      assert.equal(requests.filter(r => r.method === 'POST').length, count + 1); assert.equal(h.children.length, 1);
    } finally { postStatus = 200; }
  }
});

test('mock acceptance refuses HAI clients and HAI trial refuses mock before spawning any connection', async () => {
  const { file } = await client('reject-mock-check');
  await assert.rejects(checkApplicationClient({ clientFile: file, out: path.join(temporary, 'forbidden-report.json'), interruptSsh: true }), /mock-only/);
  const mockClient = path.join(temporary, 'mock-client.json');
  await initializeApplicationClient(mockClient, { mock: true, sshTarget: 'test@ecs.example', identityFile: sshKey, knownHostsFile: knownHosts, pairingDirectory: mockInfo.clientDirectory });
  await assert.rejects(tryHai({ clientFile: mockClient, out: path.join(temporary, 'forbidden-trial.json'), infer: true }), /not a mock/);
});

test('real delivery has nine allowlisted files and can be installed/imported privately off-source', { timeout: 60000 }, async () => {
  await assert.rejects(buildApplicationDelivery({ pairingDirectory: serverInfo.clientDirectory, outputRoot: path.join(temporary, 'refused-mock-pack') }));
  const result = await buildApplicationDelivery({ pairingDirectory: serverInfo.clientDirectory, mode: 'hai',
    outputRoot: path.join(temporary, 'delivery'), npmCli: process.env.npm_execpath });
  const { stdout } = await execute('tar', ['-tzf', result.archive]);
  const files = stdout.trim().split('\n').filter(f => !f.endsWith('/')); assert.equal(files.length, 9);
  assert.equal(files.some(f => /server.key|ca.key|auth.json|known_hosts/.test(f)), false);
  const extracted = path.join(temporary, 'extract'); await fs.mkdir(extracted);
  await execute('tar', ['-xzf', result.archive, '-C', extracted]);
  const bundle = path.join(extracted, 'hai-app-hai-trial'), manifest = JSON.parse(await fs.readFile(path.join(bundle, 'bundle.json')));
  assert.equal(manifest.mode, 'hai');
  const prefix = path.join(temporary, 'private install');
  await execute(process.execPath, [process.env.npm_execpath, 'install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', path.join(temporary, 'cache'), path.join(bundle, manifest.filename)], { timeout: 30000 });
  const cli = path.join(prefix, 'node_modules/hai-bridge/bin/hai-bridge.mjs'), out = path.join(temporary, 'installed-client.json');
  const { stdout: initialized } = await execute(process.execPath, [cli, 'init-app-client', '--hai', '--pairing-dir', path.join(bundle, 'client-pair'),
    '--ssh-target', 'test@ecs.example', '--identity-file', sshKey, '--known-hosts-file', knownHosts, '--out', out], { cwd: bundle });
  assert.equal((await loadApplicationConfig(out, 'client')).mode, 'hai'); assert.equal(initialized.includes(SYNTHETIC_KEY), false);
  await assert.rejects(execute(process.execPath, [cli, 'init-app-client', '--hai', '--upstream-auth-file', authFile]));
});
