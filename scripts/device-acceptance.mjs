// Standalone: copy only this file; reuse the installed clockfix runtime, not a new package.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const HELP = [
  'V2 acceptance: MOCK -> private real enrollment -> HAI probe -> local Codex task.',
  'Node.js 22+, existing clockfix runtime, Codex and outbound SSH keys; no administrator needed.',
  'node device-acceptance.mjs [--cli INSTALLED_CLI] [--mock-config PATH]',
  '  [--client-config REAL_V2_PATH] [--invitation PRIVATE_FILE] [--project-root DIRECTORY]',
  '  [--model MODEL] [--skip-mock] [--renewal]',
  'Defaults: ~/.hai-bridge-v2-mock/runtime-clockfix/node_modules/hai-bridge/bin/hai-bridge.mjs',
  '  ~/.hai-bridge-v2-mock/client.json; ~/.hai-bridge-v2-hai/client.json',
  '  ~/.hai-bridge-v2-hai/invite-windows.json; project root = current directory',
  '--renewal adds 12 minutes of GET-only session continuity checks.',
  'Billing requires typing RUN. No software installation, VPN/SSH changes or POST auto-replay.',
  'Existing real identity is reused, never overwritten. First use pauses for A invitation/approval.',
].join('\n');

export async function loadAcceptanceApi(cli) {
  const root = path.dirname(path.dirname(path.resolve(cli)));
  const modules = await Promise.all(['app-config', 'device-config', 'device-checks', 'device-enrollment',
    'client', 'app-runtime', 'app-readiness', 'session', 'device-store', 'device-registry']
    .map(name => import(pathToFileURL(path.join(root, 'src', name + '.mjs')).href)));
  return Object.assign({}, ...modules);
}

export function acceptanceOptions(values = {}, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const mockRoot = path.join(home, '.hai-bridge-v2-mock'), realRoot = path.join(home, '.hai-bridge-v2-hai');
  return { cli: path.resolve(values.cli || path.join(mockRoot, 'runtime-clockfix', 'node_modules', 'hai-bridge', 'bin', 'hai-bridge.mjs')),
    mockConfig: path.resolve(values['mock-config'] || path.join(mockRoot, 'client.json')),
    clientConfig: path.resolve(values['client-config'] || path.join(realRoot, 'client.json')),
    invitation: path.resolve(values.invitation || path.join(realRoot, 'invite-windows.json')),
    projectRoot: path.resolve(values['project-root'] || cwd), model: values.model || 'gpt-6.1-sol',
    skipMock: Boolean(values['skip-mock']), renewal: Boolean(values.renewal) };
}

export function acceptanceCodexArguments(extra, { platform = process.platform } = {}) {
  // Also works with the already-delivered clockfix runtime: explicit, exec-local flags.
  return ['exec', '--sandbox', 'workspace-write',
    ...(platform === 'win32' ? ['-c', 'windows.sandbox="mxc"'] : []),
    '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', ...extra];
}

const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

export async function makePractice(root) {
  const project = await fs.mkdtemp(path.join(await fs.realpath(root), 'hai-bridge-practice-'));
  await fs.mkdir(path.join(project, 'src')); await fs.mkdir(path.join(project, 'test'));
  await fs.writeFile(path.join(project, 'src', 'sum.mjs'),
    'export function sum(values) { return values.reduce((total, value) => total - value, 0); }\n', { flag: 'wx' });
  await fs.writeFile(path.join(project, 'test', 'sum.test.mjs'), [
    "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { sum } from '../src/sum.mjs';",
    "test('empty', () => assert.equal(sum([]), 0));",
    "test('positive', () => assert.equal(sum([1, 2, 3]), 6));",
    "test('negative', () => assert.equal(sum([-1, -2, -3]), -6));",
    "test('decimal', () => assert.equal(sum([0.5, 1.25, -0.25]), 1.5));", '',
  ].join('\n'), { flag: 'wx' });
  await fs.writeFile(path.join(project, 'environment.json'), JSON.stringify({ platform: process.platform,
    evidence: randomBytes(12).toString('hex'), cwd: project }, null, 2) + '\n', { flag: 'wx' });
  return { project, testFile: path.join(project, 'test', 'sum.test.mjs'), environmentFile: path.join(project, 'environment.json') };
}

export async function runPracticeTests(project, signal) {
  const testEnv = { ...process.env };
  delete testEnv.NODE_TEST_CONTEXT; // Nested local regression must still launch an independent test runner.
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', 'test/sum.test.mjs'],
      { cwd: project, env: testEnv, signal, timeout: 30000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error && !Number.isInteger(error.code)) { reject(new Error('Practice test process unavailable')); return; }
        const count = name => { const match = stdout.match(new RegExp('^# ' + name + ' ([0-9]+)$', 'm')); return match ? Number(match[1]) : null; };
        resolve({ code: error?.code ?? 0, tests: count('tests'), passed: count('pass'), failed: count('fail') });
      });
  });
}

export async function withOwnedRealClient(api, config, action, { signal, onEvent = () => {} } = {}) {
  const signals = new EventEmitter(), abort = new AbortController();
  let service, ended = false, code, failure, ready;
  const listening = new Promise(resolve => { ready = resolve; });
  const stop = () => { abort.abort(); signals.emit('SIGTERM'); };
  signal?.addEventListener('abort', stop, { once: true });
  let task;
  try {
    if (signal?.aborted) throw new Error('Interrupted');
    task = api.runApplication(config, { signals, onEvent, onListening(value) { service = value; ready(); } })
      .then(value => { code = value; ended = true; abort.abort(); }, error => { failure = error; ended = true; abort.abort(); });
    await Promise.race([listening, task]);
    if (!service || ended || signal?.aborted) throw new Error('Real client unavailable');
    await api.waitForApplication(config, { signal: abort.signal, shouldStop: () => ended });
    return await action(abort.signal);
  } finally {
    stop(); await task; signal?.removeEventListener('abort', stop);
    if (failure || (code !== undefined && code !== 0)) throw Object.assign(new Error('Owned client transport/cleanup failed'), { code: failure?.code });
  }
}

export async function runAcceptance(options, { api, ask, log = console.log, signals = process,
  tests = runPracticeTests, sleep = pause } = {}) {
  api ||= await loadAcceptanceApi(options.cli);
  const abort = new AbortController(), stop = () => abort.abort();
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  let terminal;
  if (!ask) {
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    ask = text => terminal.question(text, { signal: abort.signal });
  }
  const stamp = Date.now() + '-' + randomBytes(4).toString('hex');
  const reportFile = path.join(path.dirname(options.clientConfig), 'results', 'acceptance-' + stamp + '.json');
  const report = { transport: 'app-device', platform: process.platform, node: process.versions.node,
    evidence: 'device-acceptance-B-ECS-A', status: 'fail', checks: [], inference_attempted: false,
    not_checked: ['A_revocation', 'A_server_certificate_renewal', 'A_outer_link_recovery', 'VPN_sleep_resume',
      'Windows_ACL', 'WSL_unless_run_in_WSL', 'long_term_stability', 'session_continuity'] };
  let stage = 'preflight', real, claim = false;
  const check = async (name, action, cleanup = false) => {
    stage = name;
    try {
      if (abort.signal.aborted && !cleanup) throw new Error('Interrupted');
      log('[CHECK] ' + name); const result = await action();
      if (abort.signal.aborted && !cleanup) throw new Error('Interrupted');
      report.checks.push({ check: name, status: 'pass' }); return result;
    } catch (error) {
      const item = { check: name, status: 'fail' };
      const http = /\bHTTP ([1-5][0-9]{2})\b/.exec(error.message || '');
      if (http) item.http_status = Number(http[1]);
      if (['EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT', 'SSH_STOP_TIMEOUT', 'LOCAL_STOP_ERROR'].includes(error.code)) item.reason = error.code;
      report.checks.push(item); report.failed_check ||= name; throw new Error('Acceptance stage failed');
    }
  };
  const event = value => {
    if (['application', 'ssh', 'session'].includes(value.event) &&
      ['listening', 'starting', 'forward_ready', 'retry_wait', 'failed', 'stopped', 'connecting', 'ready', 'codex_starting', 'cleanup_failed'].includes(value.state)) {
      log('[LINK] ' + value.event + ': ' + value.state);
    }
  };
  const free = async config => { await api.assertPortFree(config.localPort); await api.assertPortFree(config.tunnelPort); };
  const ensureHai = result => {
    if (result.bridge !== 'ok' || result.hai !== 'ok' || result.mock !== false || result.configured_model_available !== true) throw new Error('Real HAI/model unavailable');
  };
  try {
    await api.privateDirectory(path.dirname(reportFile), { create: true });
    await api.createPrivate(reportFile, JSON.stringify(report, null, 2) + '\n'); claim = true;
    const mock = await check('existing-mock-profile-and-free-ports', async () => {
      const config = await api.loadApplicationConfig(options.mockConfig, 'client');
      if (config.transport !== 'app-device' || config.mode !== 'mock') throw new Error('Expected independent v2 mock profile');
      await free(config); return config;
    });
    await check('project-root-outside-private-profiles', async () => {
      const root = await fs.realpath(options.projectRoot);
      for (const file of [options.mockConfig, options.clientConfig]) {
        const parent = await fs.realpath(path.dirname(file)), relative = path.relative(parent, root);
        if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
          throw new Error('Project must be outside private profiles');
        }
      }
    });
    await check('codex-offline-help-compatible', async () => {
      // Parser-only: no tunnel, control request or inference. Do not auto-install software.
      const code = await api.runCodex(mock, api.clientOrigin(mock),
        acceptanceCodexArguments(['--help']), process.env, { signal: abort.signal });
      if (code !== 0) throw new Error('Codex not installed or incompatible');
    });
    if (!options.skipMock) {
      await check('full-v2-mock-acceptance', async () => {
        const out = path.join(path.dirname(reportFile), 'mock-' + stamp + '.json');
        const result = await api.checkDeviceClient({ clientFile: options.mockConfig, out }, { signals, onEvent: event });
        report.mock_checks = result.report.checks.map(({ check, status, http_status, reason }) => ({ check, status,
          ...(Number.isInteger(http_status) ? { http_status } : {}),
          ...(['application_authentication_unavailable', 'application_client_unauthorized', 'application_tls_transport_failed', 'bridge_unauthorized', 'mock_models_http_error'].includes(reason) ? { reason } : {}) }));
        if (result.report.status !== 'pass' || result.report.checks.length !== 15 || result.report.checks.some(item => item.status !== 'pass')) throw new Error('MOCK acceptance failed');
        log('MOCK: 15/15 PASS. Its B HTTP/SSH have stopped.');
      });
    } else report.mock_checks = 'skipped_by_user';

    if (!(await exists(options.clientConfig))) {
      log('\n[PAUSE 1] Stop ONLY the old Mac MOCK publisher. Keep VPN/HAI running.');
      log('On Mac run scripts/prepare-device-hai.mjs with the existing real v1 server config.');
      log('Privately copy ONLY its invitation to: ' + options.invitation);
      log('Invitation expires after 15 minutes. Keep the new Mac publisher terminal open.');
      await check('private-real-invitation-and-enrollment', async () => {
        await ask('After invitation transfer and A startup, press Enter: ');
        const invite = api.validateInvitation(await api.readPrivateJson(options.invitation, 24000));
        if (invite.trust.mode !== 'hai') throw new Error('Real HAI invitation required');
        await api.initializeDeviceClient(options.clientConfig, { invitationFile: options.invitation, label: 'Personal ' + process.platform,
          model: options.model, sshTarget: mock.target, identityFile: mock.identityFile, knownHostsFile: mock.knownHostsFile,
          sshPort: mock.sshPort, relayPort: mock.relayPort, localPort: mock.localPort, tunnelPort: mock.tunnelPort, maxRetries: mock.maxRetries });
        const result = await api.enrollDevice(options.clientConfig, { signals, onEvent: event });
        if (!['pending', 'approved'].includes(result.state)) throw new Error('Enrollment unconfirmed');
      });
    }
    real = await check('independent-real-profile-same-relay', async () => {
      const config = await api.loadApplicationConfig(options.clientConfig, 'client');
      if (config.transport !== 'app-device' || config.mode !== 'hai' || config.target !== mock.target ||
        config.sshPort !== mock.sshPort || config.relayPort !== mock.relayPort || options.clientConfig === options.mockConfig) throw new Error('Independent real profile on the existing relay required');
      // Recover interrupted enrollment with the original key, never generate a replacement.
      if (await exists(path.join(config.deviceDirectory, 'invitation.json'))) await api.enrollDevice(options.clientConfig, { signals, onEvent: event });
      await free(config); return config;
    });
    log('\n[PAUSE 2] B fingerprint (compare all 64 characters on A): ' + real.pair.identity.device_id);
    log('Use the exact approval command printed on Mac, with this NEW fingerprint.');
    await ask('After A shows approved (or if already approved), press Enter: ');
    log('BILLING: one short real Responses probe and a Codex task, potentially multiple model requests.');
    log('Only a new synthetic project is used. This script never automatically replays a POST.');
    stage = 'billing-consent';
    if ((await ask('Type RUN to authorize model requests; anything else stops: ')).trim() !== 'RUN') {
      report.status = 'cancelled'; return { report, reportFile };
    }
    terminal?.close(); terminal = undefined; // Never consume stdin needed by the subsequent Codex process.

    try {
      await check('real-client-owned-lifecycle', () => withOwnedRealClient(api, real, async signal => {
        await check('real-hai-model-list', async () => {
          const result = await api.diagnose(real, api.clientOrigin(real), { signal }); ensureHai(result);
          report.models = { count: result.model_count, configured_model_available: true };
        });
        await check('real-responses-sse-completed', async () => {
          report.inference_attempted = true;
          const result = await api.probeInference(real, api.clientOrigin(real), real.model);
          if (result.http_status !== 200 || result.completed !== true) throw new Error('Inference incomplete');
          report.inference = { completed: true, input_tokens: result.input_tokens, output_tokens: result.output_tokens };
        });
        if (options.renewal) {
          await check('twelve-minute-get-only-session-continuity', async () => {
            for (let minute = 1; minute <= 12; minute++) {
              await sleep(60000, undefined, { signal });
              ensureHai(await api.diagnose(real, api.clientOrigin(real), { signal }));
              log('Session continuity: ' + minute + '/12 minutes; model-list GET only.');
            }
            report.not_checked = report.not_checked.filter(value => value !== 'session_continuity');
          });
        }
      }, { signal: abort.signal, onEvent: event }));
    } finally { await check('probe-owned-http-and-tunnel-released', () => free(real), true); }

    const practice = await check('new-B-practice-and-failing-baseline', async () => {
      const fixture = await makePractice(options.projectRoot); log('Synthetic B project (kept for inspection): ' + fixture.project);
      const result = await tests(fixture.project, abort.signal);
      if (result.code !== 1 || result.tests !== 4 || result.passed !== 1 || result.failed !== 3) throw new Error('Expected baseline: 1 pass / 3 fail');
      return fixture;
    });
    const testHash = await digest(practice.testFile), environmentHash = await digest(practice.environmentFile);
    await check('real-start-help-and-normal-cleanup', async () => {
      try {
        const code = await api.startSession({ clientFile: options.clientConfig, project: practice.project,
          userArgs: acceptanceCodexArguments(['--help']) }, { signals, onEvent: event });
        if (code !== 0) throw new Error('Start/help failed');
      } finally { await free(real); }
    });
    await check('real-codex-task-on-B', async () => {
      const task = 'Work only in this synthetic project. Read environment.json, src/sum.mjs and test/sum.test.mjs. ' +
        'Fix the bug in sum by modifying ONLY src/sum.mjs. Do not modify tests or environment.json. ' +
        'Run node --test test/sum.test.mjs. Do not install packages, access the network directly, or read outside this project. ' +
        'Finally report platform and evidence from environment.json, file changed and test results.';
      try {
        const code = await api.startSession({ clientFile: options.clientConfig, project: practice.project,
          userArgs: acceptanceCodexArguments(['-c', 'model_reasoning_effort="low"', task]) }, { signals, onEvent: event });
        report.codex_exit_code = code; if (code !== 0) throw new Error('Codex task failed');
      } finally { await free(real); }
    });
    await check('independent-tests-and-unchanged-test-environment', async () => {
      if (await digest(practice.testFile) !== testHash || await digest(practice.environmentFile) !== environmentHash) throw new Error('Protected fixture files changed');
      const result = await tests(practice.project, abort.signal);
      if (result.code !== 0 || result.tests !== 4 || result.passed !== 4 || result.failed !== 0) throw new Error('Independent tests failed');
      report.practice = { platform: process.platform, tests: 4, passed: 4, tests_unchanged: true, environment_unchanged: true };
    });
    await check('final-owned-http-and-tunnel-released', () => free(real), true);
    report.status = 'pass';
  } catch {
    report.status = abort.signal.aborted ? 'interrupted' : 'fail';
    if (!report.failed_check) { report.failed_check = stage; report.checks.push({ check: stage, status: 'fail' }); }
    log('STOP: ' + report.failed_check + '. No further stage or automatic inference retry.');
    if (report.failed_check === 'codex-offline-help-compatible') log('Check Codex installation/version. If missing: npm.cmd install --global @openai/codex');
    log('Do not disable sandbox, alter VPN or kill unrelated listeners to force a pass.');
  } finally {
    terminal?.close(); signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
    if (claim) { await api.replacePrivate(reportFile, JSON.stringify(report, null, 2) + '\n'); log('Safe report: ' + reportFile); }
  }
  return { report, reportFile };
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, cli: { type: 'string' },
    'mock-config': { type: 'string' }, 'client-config': { type: 'string' }, invitation: { type: 'string' },
    'project-root': { type: 'string' }, model: { type: 'string' }, 'skip-mock': { type: 'boolean' }, renewal: { type: 'boolean' } } });
  if (values.help) { console.log(HELP); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ required');
  console.log('No Bridge reinstall needed. Stop your own old B connect-app/session first.');
  const { report } = await runAcceptance(acceptanceOptions(values));
  console.log('Acceptance: ' + report.status.toUpperCase());
  process.exitCode = report.status === 'pass' ? 0 : ['interrupted', 'cancelled'].includes(report.status) ? 130 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Acceptance cannot start/write its report. Check Node, --cli, private paths and permissions; no raw error/credentials printed.'); process.exitCode = 1; });
}
