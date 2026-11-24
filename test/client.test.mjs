import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, codexArguments } from '../src/client.mjs';
import { fixture } from './helpers.mjs';

const codexConfig = { model: 'synthetic-model', token: 'synthetic-never-in-args' };
const argsFor = (userArgs, platform) => codexArguments(codexConfig, 'http://127.0.0.1:18084', userArgs, { platform });

test('Windows interactive and exec get explicit workspace-write and exec-local MXC defaults', () => {
  for (const userArgs of [[], ['exec', '--ignore-user-config', 'synthetic task'], ['e', '--help']]) {
    const args = argsFor(userArgs, 'win32');
    const sandbox = args.indexOf('--sandbox');
    assert.equal(args[sandbox + 1], 'workspace-write');
    assert.ok(args.includes('windows.sandbox="mxc"'));
    assert.equal(args.includes('sandbox_mode="workspace-write"'), false);
    if (userArgs.length) {
      assert.ok(sandbox > args.indexOf(userArgs[0]));
      assert.ok(args.indexOf('windows.sandbox="mxc"') > args.indexOf(userArgs[0]));
    }
    assert.equal(JSON.stringify(args).includes(codexConfig.token), false);
    assert.equal(args.some(arg => arg.includes('dangerously') || arg.includes('ignore-rules')), false);
  }
});

test('Linux and Mac get workspace-write without Windows backend config', () => {
  for (const platform of ['linux', 'darwin']) {
    const args = argsFor(['exec', '--help'], platform);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args.some(arg => arg.startsWith('windows.sandbox=')), false);
  }
});

test('explicit read-only and permission selections are never replaced by a write default', () => {
  for (const input of [['--sandbox', 'read-only'], ['--sandbox=read-only'], ['-s', 'read-only'], ['-sread-only'],
    ['-c', 'sandbox_mode="read-only"'], ['--config=sandbox_mode="read-only"'], ['-csandbox_mode="read-only"'],
    ['--permission-profile', ':read-only'], ['--permission-profile=:read-only'], ['--approve-for-me']]) {
    const args = argsFor(['exec', ...input, '--help'], 'win32');
    assert.equal(args.includes('workspace-write'), false);
    assert.equal(args.includes('sandbox_mode="workspace-write"'), false);
    assert.deepEqual(args.slice(-input.length - 1), [...input, '--help']);
  }
});

test('explicit Windows backend config is preserved without duplicate MXC injection', () => {
  for (const input of [['-c', 'windows.sandbox="legacy"'], ['--config', 'windows.sandbox="legacy"'],
    ['--config=windows.sandbox="legacy"'], ['-cwindows.sandbox="legacy"']]) {
    const args = argsFor(['exec', ...input, '--help'], 'win32');
    assert.equal(args.includes('windows.sandbox="mxc"'), false);
    assert.deepEqual(args.slice(-input.length - 1), [...input, '--help']);
  }
});

test('review retains its config-compatible policy without unsupported local --sandbox', () => {
  const args = argsFor(['review', '--help'], 'win32');
  assert.equal(args.includes('--sandbox'), false);
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
});

test('doctor marks the mock upstream explicitly without claiming HAI availability', async t => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mock: true, data: [{ id: 'relay-ok' }] }));
  });
  assert.deepEqual(await diagnose({ token: f.token, model: 'relay-ok' }, f.origin), {
    bridge: 'ok', hai: 'not_checked', mock: true, model_count: 1, configured_model_available: true,
  });
});

test('doctor retains the configured-upstream result and reports a missing model', async t => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'available-model' }] }));
  });
  assert.deepEqual(await diagnose({ token: f.token, model: 'missing-model' }, f.origin), {
    bridge: 'ok', hai: 'ok', mock: false, model_count: 1, configured_model_available: false,
  });
});

test('doctor rejects upstream errors and unexpected model lists', async t => {
  for (const status of [503, 200]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic-error' }));
    });
    await assert.rejects(diagnose({ token: f.token, model: 'relay-ok' }, f.origin),
      status === 503 ? /HTTP 503/ : /unexpected model-list format/);
  }
});
