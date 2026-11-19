import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/client.mjs';
import { fixture } from './helpers.mjs';

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
