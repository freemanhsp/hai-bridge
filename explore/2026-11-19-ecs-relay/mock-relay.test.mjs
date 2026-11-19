import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { startMockRelay, MOCK_TOKEN } from './mock-relay.mjs';

async function fixture(t, overrides = {}) {
  const relay = await startMockRelay({ port: 0, intervalMs: 30, ...overrides });
  t.after(() => relay.close());
  return { ...relay, headers: { Authorization: `Bearer ${MOCK_TOKEN}` } };
}

test('mock is loopback-only and actual bridge replaces public fixture token', async t => {
  const f = await fixture(t);
  assert.equal(f.bridge.address().address, '127.0.0.1');
  assert.equal(f.upstream.address().address, '127.0.0.1');
  const response = await fetch(`${f.origin}/openai/v1/models`, { headers: f.headers });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mock, true);
  assert.equal(body.data[0].id, 'relay-ok');
  assert.equal(f.stats.rejectedAuth, 0);
});

test('missing bridge token never reaches mock upstream', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/openai/v1/models`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'bridge_unauthorized');
  assert.equal(f.stats.requests, 0);
});

test('only the fixed Windows script artifact is served behind bridge authentication', async t => {
  const f = await fixture(t);
  const expected = await readFile(new URL('./windows-checks.ps1', import.meta.url), 'utf8');
  const response = await fetch(f.origin + '/openai/v1/models?artifact=windows-checks', { headers: f.headers });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').startsWith('text/plain'));
  assert.equal(await response.text(), expected);
  const before = f.stats.requests;
  const denied = await fetch(f.origin + '/openai/v1/models?artifact=windows-checks');
  assert.equal(denied.status, 401);
  assert.equal(f.stats.requests, before);
  const other = await fetch(f.origin + '/openai/v1/models?artifact=../../secret', { headers: f.headers });
  assert.equal((await other.json()).mock, true);
});

test('JSON and Unicode SSE survive; first delta arrives before completion', { timeout: 5000 }, async t => {
  const f = await fixture(t, { intervalMs: 150 });
  const json = await fetch(`${f.origin}/openai/v1/responses?case=json`, { method: 'POST', headers: f.headers });
  assert.equal((await json.json()).output, 'relay-ok 中文');
  const stream = await fetch(`${f.origin}/openai/v1/responses`, { method: 'POST', headers: f.headers });
  assert.ok(stream.headers.get('content-type').startsWith('text/event-stream'));
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let body = decoder.decode((await reader.read()).value, { stream: true });
  assert.match(body, /relay-/);
  assert.equal(f.stats.completedStreams, 0);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  assert.match(body, / 中文/);
  assert.match(body, /response.completed/);
  assert.equal(f.stats.completedStreams, 1);
});

test('client cancellation closes upstream stream and stops timers', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(`${f.origin}/openai/v1/responses?case=cancel`,
    { method: 'POST', headers: f.headers, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let attempt = 0; attempt < 100 && !f.stats.cancelledStreams; attempt++) await delay(10);
  assert.equal(f.stats.cancelledStreams, 1);
  assert.equal(f.stats.activeStreams, 0);
  assert.equal(f.stats.completedStreams, 0);
});

test('mock 429 and 503 preserve status, body and retry hint without replay', async t => {
  const f = await fixture(t);
  for (const status of [429, 503]) {
    const before = f.stats.requests;
    const response = await fetch(`${f.origin}/openai/v1/responses?case=${status}`, { method: 'POST', headers: f.headers });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.equal((await response.json()).error.code, `mock_${status}`);
    assert.equal(f.stats.requests, before + 1);
  }
});

test('mock upstream stall and connection loss exercise bridge 504 and 502', { timeout: 5000 }, async t => {
  const f = await fixture(t, { idleTimeoutMs: 100 });
  for (const [scenario, status, code] of [['stall', 504, 'upstream_timeout'], ['disconnect', 502, 'upstream_unavailable']]) {
    const response = await fetch(`${f.origin}/openai/v1/responses?case=${scenario}`, { method: 'POST', headers: f.headers });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});
