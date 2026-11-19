import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';

const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('Local proxy key unavailable');
const endpoint = '/openai/v1/responses';
const payload = JSON.stringify({
  model: 'gpt-6-luna', input: 'Reply only with OK.',
  max_output_tokens: 64, reasoning: { effort: 'low' }, store: false, stream: true,
});

async function probe(name, port) {
  try {
    const result = await new Promise((resolve, reject) => {
      const start = performance.now();
      const req = http.request({
        host: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
          'User-Agent': 'hai-forwarding-feasibility-probe/1.0', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        let body = '', firstChunkMs;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (firstChunkMs === undefined) firstChunkMs = Math.round(performance.now() - start);
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          const events = [], deltas = [];
          let usage, responseStatus;
          for (const line of body.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const event = JSON.parse(raw);
              if (typeof event.type === 'string') events.push(event.type);
              if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') deltas.push(event.delta);
              if (event.response?.usage) usage = event.response.usage;
              if (event.response?.status) responseStatus = event.response.status;
            } catch {}
          }
          let errorCode;
          try { const d = JSON.parse(body); const c = d.error?.code || d.error?.type;
            if (typeof c === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(c)) errorCode = c; } catch {}
          resolve({ name, http_status: res.statusCode, content_type: res.headers['content-type'],
            first_chunk_ms: firstChunkMs, duration_ms: Math.round(performance.now() - start),
            sse_event_count: events.length, sse_event_types: [...new Set(events)],
            output_characters: deltas.join('').length, response_status: responseStatus,
            input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens, error_code: errorCode });
        });
      });
      req.setTimeout(45000, () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
      req.end(payload);
    });
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    console.log(JSON.stringify({ name, failure: error.code || error.name }));
    return {};
  }
}

const direct = await probe('direct_responses_stream', 6655);
if (direct.http_status !== 200 || direct.sse_event_count === 0) {
  console.log(JSON.stringify({ relay_test: 'skipped', reason: 'Direct streaming baseline did not succeed' }));
  process.exitCode = 1;
} else {
  const relay = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== endpoint) { res.writeHead(404).end(); return; }
    const upstream = http.request({ host: '127.0.0.1', port: 6655, path: req.url, method: req.method, headers: req.headers }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.setTimeout(45000, () => upstream.destroy(new Error('Timeout')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  try {
    await probe('relay_responses_stream_preserving_host', relay.address().port);
  } finally {
    await new Promise(resolve => relay.close(resolve));
    console.log(JSON.stringify({ temporary_relay: 'closed' }));
  }
}
