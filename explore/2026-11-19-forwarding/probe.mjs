import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
const key = auth.OPENAI_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('Local proxy key unavailable');
const endpoint = '/openai/v1/models';
const upstreamPort = 6655;

async function probe(name, port, headers = {}) {
  try {
    const summary = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: endpoint, method: 'GET', headers }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          let data;
          try { data = JSON.parse(body); } catch {}
          resolve({
            name, status: res.statusCode, content_type: res.headers['content-type'],
            model_count: Array.isArray(data?.data) ? data.data.length : undefined,
          });
        });
      });
      req.setTimeout(12000, () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
      req.end();
    });
    console.log(JSON.stringify(summary));
    return summary.status;
  } catch (error) {
    console.log(JSON.stringify({ name, failure: error.code || error.name }));
    return undefined;
  }
}

await probe('direct_without_key', upstreamPort);
await probe('direct_invalid_key', upstreamPort, { Authorization: 'Bearer intentionally-invalid-probe-key' });
const validHeaders = { Authorization: 'Bearer ' + key };
const directStatus = await probe('direct_valid_key', upstreamPort, validHeaders);
if (directStatus !== 200) {
  console.log(JSON.stringify({ relay_test: 'skipped', reason: 'Baseline authenticated request did not succeed' }));
  process.exitCode = 1;
} else {
  const relay = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== endpoint) { res.writeHead(404).end(); return; }
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.setTimeout(12000, () => upstream.destroy(new Error('Timeout')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayPort = relay.address().port;
  console.log(JSON.stringify({ temporary_relay: 'listening on loopback only', relay_port: relayPort }));
  try {
    await probe('relay_without_key', relayPort);
    await probe('relay_valid_key_preserving_host', relayPort, validHeaders);
    await probe('relay_valid_key_nonlocal_host', relayPort, { ...validHeaders, Host: 'forwarding-probe.invalid:6655' });
    await probe('relay_valid_key_forwarding_metadata', relayPort, { ...validHeaders, Origin: 'https://forwarding-probe.invalid', 'X-Forwarded-For': '192.0.2.10' });
  } finally {
    await new Promise(resolve => relay.close(resolve));
    console.log(JSON.stringify({ temporary_relay: 'closed' }));
  }
}
