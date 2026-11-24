import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { acceptanceOptions, acceptanceCodexArguments, makePractice, runPracticeTests, runAcceptance, loadAcceptanceApi } from '../scripts/device-acceptance.mjs';
import { prepareDeviceHai } from '../scripts/prepare-device-hai.mjs';
import { privateDirectory, createPrivate, replacePrivate } from '../src/device-store.mjs';

test('acceptance explicitly forwards tested sandbox flags even to the old runtime', () => {
  const windows = acceptanceCodexArguments(['--help'], { platform: 'win32' });
  assert.deepEqual(windows.slice(0, 5), ['exec', '--sandbox', 'workspace-write', '-c', 'windows.sandbox="mxc"']);
  assert.ok(windows.includes('--ignore-user-config'));
  assert.equal(acceptanceCodexArguments(['--help'], { platform: 'linux' }).some(arg => arg.startsWith('windows.sandbox=')), false);
});

async function synthetic(t, { existing = false, answers, patch = {}, renewal = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-acceptance-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = acceptanceOptions({}, { home: root, cwd: root }); options.renewal = renewal;
  await fs.mkdir(path.dirname(options.mockConfig), { mode: 0o700 });
  await fs.writeFile(options.mockConfig, '{}', { mode: 0o600 });
  const hidden = 'synthetic-do-not-log-token-or-reply';
  const base = { role: 'client', transport: 'app-device', target: 'synthetic@127.0.0.1', sshPort: 22222,
    relayPort: 32100, localPort: 32101, tunnelPort: 32102, token: hidden, identityFile: path.join(root, 'synthetic-ssh-key'),
    knownHostsFile: path.join(root, 'synthetic-hosts'), maxRetries: 1 };
  const mock = { ...base, mode: 'mock', model: 'relay-ok' }, real = { ...base, mode: 'hai', model: 'synthetic-model',
    deviceDirectory: options.clientConfig + '.device', pair: { identity: { device_id: 'd'.repeat(64) } } };
  const calls = { init: 0, enroll: 0, mock: 0, probes: 0, diagnoses: 0, help: 0, tasks: 0, runtimeStops: 0, free: 0, sleeps: 0 };
  const logs = [], signals = new EventEmitter();
  const api = { privateDirectory, createPrivate, replacePrivate,
    loadApplicationConfig: async file => file === options.mockConfig ? mock : real,
    assertPortFree: async () => { calls.free++; }, clientOrigin: () => 'http://127.0.0.1:32101',
    runCodex: async (_config, _origin, args) => { assert.ok(args.includes('--help')); calls.help++; return 0; },
    checkDeviceClient: async () => { calls.mock++; return { report: { status: 'pass', checks: Array.from({ length: 15 }, (_, i) => ({ check: 'synthetic-' + i, status: 'pass' })) } }; },
    readPrivateJson: async () => ({ trust: { mode: 'hai' } }), validateInvitation: value => value,
    initializeDeviceClient: async file => {
      calls.init++; await privateDirectory(path.dirname(file), { create: true });
      await fs.mkdir(real.deviceDirectory, { mode: 0o700 }); await fs.writeFile(file, '{}', { flag: 'wx', mode: 0o600 });
    },
    enrollDevice: async () => { calls.enroll++; return { device_id: real.pair.identity.device_id, state: 'pending' }; },
    runApplication: async (_config, { signals: owned, onListening }) => new Promise(resolve => {
      owned.once('SIGTERM', () => { calls.runtimeStops++; resolve(0); }); queueMicrotask(() => onListening({ origin: 'synthetic-loopback' }));
    }),
    waitForApplication: async () => {},
    diagnose: async () => { calls.diagnoses++; return { bridge: 'ok', hai: 'ok', mock: false, model_count: 1, configured_model_available: true, private_extra: hidden }; },
    probeInference: async () => { calls.probes++; return { http_status: 200, completed: true, input_tokens: 11, output_tokens: 5, private_extra: hidden }; },
    startSession: async ({ project, userArgs }) => {
      if (userArgs.includes('--help')) { calls.help++; return 0; }
      calls.tasks++;
      await fs.writeFile(path.join(project, 'src', 'sum.mjs'), 'export function sum(values) { return values.reduce((total, value) => total + value, 0); }\n');
      return 0;
    }, ...patch,
  };
  if (existing) {
    await privateDirectory(path.dirname(options.clientConfig), { create: true });
    await fs.mkdir(real.deviceDirectory, { mode: 0o700 }); await fs.writeFile(options.clientConfig, 'original-private-config', { mode: 0o600 });
  }
  const queue = answers || (existing ? ['', 'RUN'] : ['', '', 'RUN']);
  const ask = async text => { logs.push(text); assert.ok(queue.length, 'Unexpected extra prompt'); return queue.shift(); };
  const run = () => runAcceptance(options, { api, ask, signals, log: text => logs.push(text),
    sleep: async () => { calls.sleeps++; } });
  return { options, root, real, mock, api, calls, logs, signals, hidden, run };
}

test('standalone script resolves delivered runtime API without running it', async () => {
  const api = await loadAcceptanceApi(path.resolve('bin/hai-bridge.mjs'));
  for (const name of ['runApplication', 'startSession', 'initializeDeviceClient', 'validateInvitation', 'probeInference']) assert.equal(typeof api[name], 'function');
});

test('practice has exact failing baseline and unique directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-practice-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const one = await makePractice(root), two = await makePractice(root);
  assert.notEqual(one.project, two.project);
  assert.deepEqual(await runPracticeTests(one.project), { code: 1, tests: 4, passed: 1, failed: 3 });
});

test('complete mock, real smoke, start-help, actual fixture fix, independent tests and safe report', async t => {
  const f = await synthetic(t), result = await f.run();
  assert.equal(result.report.status, 'pass');
  assert.equal(f.calls.mock, 1); assert.equal(f.calls.init, 1); assert.equal(f.calls.enroll, 1);
  assert.equal(f.calls.probes, 1); assert.equal(f.calls.tasks, 1); assert.equal(f.calls.help, 2); assert.equal(f.calls.runtimeStops, 1);
  assert.equal(result.report.mock_checks.length, 15); assert.equal(result.report.practice.passed, 4);
  assert.deepEqual(JSON.parse(await fs.readFile(result.reportFile, 'utf8')), result.report);
  assert.ok(!(await fs.readFile(result.reportFile, 'utf8')).includes(f.hidden));
  assert.ok(!f.logs.join('\n').includes(f.hidden));
  assert.equal(f.signals.listenerCount('SIGINT'), 0); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('declined billing creates no real model request or task', async t => {
  const f = await synthetic(t, { answers: ['', '', 'NO'] }), { report } = await f.run();
  assert.equal(report.status, 'cancelled'); assert.equal(report.inference_attempted, false);
  assert.equal(f.calls.probes, 0); assert.equal(f.calls.diagnoses, 0); assert.equal(f.calls.tasks, 0);
});

test('failed mock prevents invitation, enrollment and billing', async t => {
  const f = await synthetic(t, { patch: { checkDeviceClient: async () => ({ report: { status: 'fail', checks: [] } }) } });
  const { report } = await f.run(); assert.equal(report.status, 'fail');
  assert.equal(report.failed_check, 'full-v2-mock-acceptance'); assert.equal(f.calls.init, 0); assert.equal(f.calls.probes, 0);
});

test('wrong-mode invitation rejected before creating a real identity', async t => {
  const f = await synthetic(t, { patch: { readPrivateJson: async () => ({ trust: { mode: 'mock' } }) } });
  const { report } = await f.run(); assert.equal(report.failed_check, 'private-real-invitation-and-enrollment');
  assert.equal(f.calls.init, 0); assert.equal(f.calls.probes, 0);
});

test('probe failure is not retried and cleans its owned runtime', async t => {
  const f = await synthetic(t); f.api.probeInference = async () => { f.calls.probes++; throw new Error(f.hidden); };
  const { report } = await f.run(); assert.equal(report.status, 'fail'); assert.equal(report.failed_check, 'real-responses-sse-completed');
  assert.equal(f.calls.probes, 1); assert.equal(f.calls.tasks, 0); assert.equal(f.calls.runtimeStops, 1);
  assert.ok(report.checks.some(item => item.check === 'probe-owned-http-and-tunnel-released' && item.status === 'pass'));
  assert.ok(!f.logs.join('\n').includes(f.hidden));
});

test('missing model refuses inference entirely', async t => {
  const f = await synthetic(t, { patch: { diagnose: async () => ({ bridge: 'ok', hai: 'ok', mock: false, configured_model_available: false }) } });
  const { report } = await f.run(); assert.equal(report.failed_check, 'real-hai-model-list');
  assert.equal(f.calls.probes, 0); assert.equal(f.calls.tasks, 0); assert.equal(f.calls.runtimeStops, 1);
});

test('existing real identity survives rerun without init or enrollment', async t => {
  const f = await synthetic(t, { existing: true }); f.options.skipMock = true;
  const { report } = await f.run(); assert.equal(report.status, 'pass');
  assert.equal(f.calls.init, 0); assert.equal(f.calls.enroll, 0); assert.equal(f.calls.mock, 0);
  assert.equal(await fs.readFile(f.options.clientConfig, 'utf8'), 'original-private-config');
});

test('existing different relay is rejected without changing network path', async t => {
  const f = await synthetic(t, { existing: true }); f.real.target = 'other@127.0.0.2';
  const { report } = await f.run(); assert.equal(report.failed_check, 'independent-real-profile-same-relay'); assert.equal(f.calls.probes, 0);
});

test('private profile cannot become the agent project root', async t => {
  const f = await synthetic(t, { existing: true }); f.options.projectRoot = path.dirname(f.options.clientConfig);
  const { report } = await f.run(); assert.equal(report.failed_check, 'project-root-outside-private-profiles'); assert.equal(f.calls.probes, 0);
});

test('test tampering cannot turn an agent task into acceptance', async t => {
  const f = await synthetic(t), original = f.api.startSession;
  f.api.startSession = async args => { const code = await original(args); if (!args.userArgs.includes('--help')) await fs.appendFile(path.join(args.project, 'test', 'sum.test.mjs'), '// tampered\n'); return code; };
  const { report } = await f.run(); assert.equal(report.status, 'fail'); assert.equal(report.failed_check, 'independent-tests-and-unchanged-test-environment');
});

test('optional continuity uses 12 GET intervals, not 12 additional probes', async t => {
  const f = await synthetic(t, { renewal: true }), { report } = await f.run();
  assert.equal(report.status, 'pass'); assert.equal(f.calls.sleeps, 12); assert.equal(f.calls.diagnoses, 13); assert.equal(f.calls.probes, 1);
  assert.ok(!report.not_checked.includes('session_continuity'));
});

test('interrupt at the real TLS wait cleans ownership and writes interrupted report', async t => {
  const f = await synthetic(t);
  f.api.waitForApplication = async () => { f.signals.emit('SIGINT'); throw new Error('Interrupted'); };
  const { report } = await f.run(); assert.equal(report.status, 'interrupted'); assert.equal(f.calls.probes, 0); assert.equal(f.calls.runtimeStops, 1);
  assert.ok(report.checks.some(item => item.check === 'probe-owned-http-and-tunnel-released' && item.status === 'pass'));
});

test('owned runtime cleanup failure cannot become PASS', async t => {
  const f = await synthetic(t);
  f.api.runApplication = async (_config, { signals, onListening }) => new Promise(resolve => {
    signals.once('SIGTERM', () => { f.calls.runtimeStops++; resolve(1); }); queueMicrotask(() => onListening({}));
  });
  const { report } = await f.run(); assert.equal(report.status, 'fail'); assert.equal(report.failed_check, 'real-client-owned-lifecycle'); assert.equal(f.calls.tasks, 0);
});

test('Mac preparation preserves explicit relay/upstream references and creates separate instance', async () => {
  const calls = [], logs = [], source = { mode: 'hai', appPort: 32103, relayPort: 32100, sshPort: 22222,
    upstream: { origin: 'http://127.0.0.1:32104' }, authFile: '/synthetic/auth.json', target: 'synthetic@127.0.0.1',
    identityFile: '/synthetic/key', knownHostsFile: '/synthetic/hosts', maxRetries: 1 };
  const api = { readPrivateJson: async () => ({ synthetic: true }), normalizeApplicationConfig: () => source,
    assertPortFree: async port => calls.push(['port', port]),
    initializeDevicePublisher: async (out, options) => { calls.push(['init', out, options]); return { directory: '/synthetic/new', serverFile: '/synthetic/new/server.json' }; },
    loadApplicationConfig: async () => ({ deviceDirectory: '/synthetic/new' }),
    issueInvitation: async (_directory, file) => ({ file }), runApplication: async () => { calls.push(['run']); return 0; } };
  const result = await prepareDeviceHai({ sourceFile: '/synthetic/old/server.json', model: 'synthetic-model', out: '/synthetic/out' }, { api, log: value => logs.push(value) });
  assert.equal(result.code, 0); assert.equal(calls[0][0], 'port');
  assert.equal(calls[1][2].upstreamAuthFile, source.authFile); assert.equal(calls[1][2].sshTarget, source.target);
  assert.equal(calls[1][2].relayPort, source.relayPort); assert.equal(calls[1][2].hai, true);
  assert.ok(logs.some(value => value.includes('approve-device') && value.includes('/synthetic/new/server.json')));
});

test('Mac occupied publisher port is never killed or replaced', async () => {
  let initialized = false;
  const api = { readPrivateJson: async () => ({}), normalizeApplicationConfig: () => ({ mode: 'hai', appPort: 32103 }),
    assertPortFree: async () => { throw new Error('occupied'); }, initializeDevicePublisher: async () => { initialized = true; } };
  await assert.rejects(prepareDeviceHai({ sourceFile: '/synthetic/server.json', model: 'synthetic-model' }, { api, log: () => {} }));
  assert.equal(initialized, false);
});
