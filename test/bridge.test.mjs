import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fixture, rawRequest } from './helpers.mjs';

test('missing/wrong bridge credentials cannot reach HAI or access its credential', async t => {
  let upstreamCalls = 0, keyReads = 0;
  const f = await fixture(t, (req, res) => { upstreamCalls++; res.end(); },
    { getUpstreamKey: async () => { keyReads++; return 'secret'; } });
  for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
    const response = await fetch(`${f.origin}/openai/v1/models`, { headers });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'bridge_unauthorized');
  }
  assert.equal(upstreamCalls, 0);
  assert.equal(keyReads, 0);
});

test('bridge substitutes HAI credentials, preserves tool headers/body, and strips hop headers', async t => {
  let captured;
  const f = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured = { headers: req.headers, body };
    res.writeHead(200, { 'content-type': 'application/json', 'x-api-key': 'do-not-return',
      authorization: 'do-not-return', 'set-cookie': 'do-not-return', 'x-correlation-id': 'trace-123' });
    res.end('{"ok":true}');
  });
  const response = await rawRequest(`${f.origin}/openai/v1/responses?debug=should-not-log`, {
    method: 'POST', headers: { ...f.headers, 'x-api-key': 'b-key', 'x-goog-api-key': 'b-key',
      'user-agent': 'codex-cli-test', connection: 'x-hop', 'x-hop': 'must-be-removed', 'content-type': 'application/json' },
    body: '{"input":"private prompt"}',
  });
  assert.equal(response.status, 200);
  assert.equal(captured.headers.authorization, `Bearer ${f.key}`);
  assert.equal(captured.headers.host, new URL(f.upstreamUrl).host);
  assert.equal(captured.headers['user-agent'], 'codex-cli-test');
  for (const name of ['x-api-key', 'x-goog-api-key', 'x-hop']) assert.equal(captured.headers[name], undefined);
  assert.equal(captured.body, '{"input":"private prompt"}');
  for (const name of ['authorization', 'x-api-key', 'set-cookie']) assert.equal(response.headers[name], undefined);
  assert.equal(response.headers['x-correlation-id'], 'trace-123');
  const logs = JSON.stringify(f.logs);
  for (const value of [f.token, f.key, 'private prompt', 'should-not-log']) assert.equal(logs.includes(value), false);
});

test('request destinations and methods are restricted; health needs no upstream access', async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => { calls++; res.end(); });
  for (const [route, method, expected] of [
    ['/admin', 'GET', 404], ['/anthropic/v1/messages', 'POST', 404],
    ['/openai/v1/responses', 'DELETE', 405], ['/openai/v1/%2e%2e/admin', 'GET', 400],
    ['//other.example/openai/v1/models', 'GET', 400],
  ]) {
    const response = await rawRequest(f.origin + route, { headers: f.headers, method, target: route });
    assert.equal(response.status, expected, route);
  }
  const health = await fetch(`${f.origin}/healthz`, { headers: f.headers });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'hai-bridge');
  assert.equal(calls, 0);
});

test('SSE reaches the client before the upstream finishes and cancellation closes upstream', { timeout: 5000 }, async t => {
  let finished = false, markClosed;
  const upstreamClosed = new Promise(resolve => { markClosed = resolve; });
  const f = await fixture(t, (req, res) => {
    res.on('close', markClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    res.on('finish', () => { finished = true; });
  });
  const controller = new AbortController();
  const response = await fetch(`${f.origin}/openai/v1/responses`, { method: 'POST', headers: f.headers,
    body: '{}', signal: controller.signal });
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /hello/);
  assert.equal(finished, false);
  controller.abort();
  await reader.cancel().catch(() => {});
  await upstreamClosed;
});

test('compressed response bytes survive forwarding unchanged', async t => {
  const compressed = gzipSync('Unicode: 中文; streamed payload');
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
    res.end(compressed);
  });
  const response = await rawRequest(`${f.origin}/openai/v1/models`, { headers: f.headers });
  assert.deepEqual(response.body, compressed);
  assert.equal(response.headers['content-encoding'], 'gzip');
});

test('HAI 429 status, retry hint, and body survive; a POST is not retried', async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => {
    calls++; res.writeHead(429, { 'retry-after': '15', 'content-type': 'application/json' });
    res.end('{"error":"capacity"}');
  });
  const response = await fetch(`${f.origin}/openai/v1/responses`, { method: 'POST', headers: f.headers, body: '{}' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '15');
  assert.equal(await response.text(), '{"error":"capacity"}');
  assert.equal(calls, 1);
});

test('idle upstream produces 504; credential failures reveal no raw error', async t => {
  const stalled = await fixture(t, () => {}, { idleTimeoutMs: 100 });
  const response = await fetch(`${stalled.origin}/openai/v1/models`, { headers: stalled.headers });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  const broken = await fixture(t, () => {}, { getUpstreamKey: async () => { throw new Error('SECRET-CONTENT'); } });
  const failure = await fetch(`${broken.origin}/openai/v1/models`, { headers: broken.headers });
  assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes('SECRET-CONTENT'), false);
});

test('large request body arrives intact without JSON transformation', async t => {
  const input = Buffer.alloc(1024 * 1024, 97);
  let result;
  const f = await fixture(t, async (req, res) => {
    const hash = createHash('sha256');
    for await (const chunk of req) hash.update(chunk);
    result = hash.digest('hex'); res.end('{}');
  });
  const response = await rawRequest(`${f.origin}/openai/v1/responses`, { method: 'POST', headers: f.headers,
    chunks: [input.subarray(0, 200000), input.subarray(200000)] });
  assert.equal(response.status, 200);
  assert.equal(result, createHash('sha256').update(input).digest('hex'));
});

test('both fixed-length and chunked oversized bodies are rejected', async t => {
  const f = await fixture(t, (req, res) => { req.resume(); req.on('end', () => res.end('{}')); }, { maxRequestBytes: 128 });
  const fixed = await rawRequest(`${f.origin}/openai/v1/responses`, { method: 'POST',
    headers: { ...f.headers, 'content-length': '200' }, body: Buffer.alloc(200) });
  assert.equal(fixed.status, 413);
  const chunked = await rawRequest(`${f.origin}/openai/v1/responses`, { method: 'POST',
    headers: f.headers, chunks: [Buffer.alloc(100), Buffer.alloc(100)] });
  assert.equal(chunked.status, 413);
});
