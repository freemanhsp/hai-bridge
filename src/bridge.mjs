import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream';
import { loopbackUrl, validateToken } from './config.mjs';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);

export function stripHeaders(headers, response = false) {
  const blocked = new Set([...HOP_HEADERS, ...CREDENTIAL_HEADERS]);
  if (response) blocked.add('set-cookie');
  for (const name of String(headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string') return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

function sendError(res, status, code) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code } }));
}

function allowedMethod(pathname, providers) {
  for (const provider of providers) {
    const base = `/${provider}/v1`;
    if (provider === 'openai' || provider === 'litellm') {
      if (pathname === `${base}/models`) return 'GET';
      if (['responses', 'responses/compact', 'chat/completions', 'embeddings']
        .some(suffix => pathname === `${base}/${suffix}`)) return 'POST';
    }
    if (provider === 'anthropic') {
      if (pathname === `${base}/models`) return 'GET';
      if (pathname === `${base}/messages`) return 'POST';
    }
    if (provider === 'gemini') {
      if (pathname === '/gemini/v1beta/models') return 'GET';
      if (/^[/]gemini[/]v1beta[/]models[/][A-Za-z0-9_.-]+:(generateContent|streamGenerateContent|embedContent)$/.test(pathname)) return 'POST';
    }
  }
  return undefined;
}

export function createBridge(options) {
  if (options.authorize !== undefined && typeof options.authorize !== 'function') throw new Error('Invalid bridge authorization hook');
  if (!options.authorize && typeof options.getBridgeToken !== 'function') throw new Error('Bridge requires an explicit authentication strategy');
  const upstreamOrigin = loopbackUrl(options.upstream?.href || options.upstream || 'http://127.0.0.1:6655');
  const providers = options.providers || ['openai'];
  const idleTimeoutMs = options.idleTimeoutMs || 120000;
  const maxRequestBytes = options.maxRequestBytes || 67108864;
  const logger = options.logger || (() => {});

  const server = http.createServer((req, res) => {
    const requestId = randomUUID();
    const start = performance.now();
    let route = '(rejected)', logged = false;
    res.setHeader('x-hai-bridge-request-id', requestId);
    const log = outcome => {
      if (logged) return;
      logged = true;
      // No query strings, prompts, model output, headers, or credentials are logged.
      logger({ event: 'request', request_id: requestId, method: req.method,
        path: route, status: res.statusCode, outcome, duration_ms: Math.round(performance.now() - start) });
    };
    res.on('finish', () => log('finished'));
    res.on('close', () => log('closed'));

    handle().catch(() => sendError(res, 503, 'bridge_credentials_unavailable'));

    async function handle() {
      let authorized;
      if (options.authorize) authorized = await options.authorize(req, res) === true;
      else {
        const expectedToken = validateToken(await options.getBridgeToken());
        const authorization = req.headers.authorization;
        authorized = authorization?.startsWith('Bearer ') && tokenMatches(authorization.slice(7), expectedToken);
      }
      if (!authorized) {
        res.setHeader('www-authenticate', 'Bearer');
        sendError(res, 401, 'bridge_unauthorized');
        return;
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')
          || /[\\%]/.test(req.url.split('?')[0]) || req.url.split('?')[0].split('/').includes('..')) {
        sendError(res, 400, 'invalid_request_target');
        return;
      }
      const target = new URL(req.url, 'http://bridge.invalid');
      if (target.pathname === '/healthz' && req.method === 'GET') {
        route = '/healthz';
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok', service: 'hai-bridge', providers }));
        return;
      }
      const method = allowedMethod(target.pathname, providers);
      if (!method) { sendError(res, 404, 'route_not_allowed'); return; }
      route = target.pathname;
      if (req.method !== method) {
        res.setHeader('allow', method);
        sendError(res, 405, 'method_not_allowed');
        return;
      }
      if (Number(req.headers['content-length'] || 0) > maxRequestBytes) {
        sendError(res, 413, 'request_too_large');
        return;
      }
      const upstreamKey = await options.getUpstreamKey();
      if (typeof upstreamKey !== 'string' || !upstreamKey || /[\r\n]/.test(upstreamKey)) {
        throw new Error('Invalid upstream credential');
      }
      if (req.aborted || res.destroyed) return;
      const headers = stripHeaders(req.headers);
      headers.host = upstreamOrigin.host;
      headers.authorization = `Bearer ${upstreamKey}`;
      const upstreamTarget = new URL(target.pathname + target.search, upstreamOrigin);
      let bodyBytes = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          bodyBytes += chunk.length;
          if (bodyBytes > maxRequestBytes) callback(new Error('request_too_large'));
          else callback(null, chunk);
        },
      });
      // http.request does not follow redirects or retry POST requests.
      const upstream = http.request(upstreamTarget, { method: req.method, headers }, upstreamResponse => {
        if (res.destroyed) { upstreamResponse.destroy(); return; }
        res.writeHead(upstreamResponse.statusCode, stripHeaders(upstreamResponse.headers, true));
        res.flushHeaders();
        // Preserve bytes and backpressure; this also streams SSE and compressed responses.
        pipeline(upstreamResponse, res, () => {});
      });
      upstream.setTimeout(idleTimeoutMs, () => {
        sendError(res, 504, 'upstream_timeout');
        upstream.destroy();
      });
      upstream.on('error', () => {
        if (!res.writableEnded && !res.destroyed) sendError(res, 502, 'upstream_unavailable');
      });
      limiter.on('error', () => {
        req.unpipe(limiter);
        if (!res.headersSent) res.setHeader('connection', 'close');
        sendError(res, 413, 'request_too_large');
        upstream.destroy();
        req.resume();
      });
      const cancel = () => {
        req.unpipe(limiter);
        limiter.destroy();
        upstream.destroy();
      };
      req.on('aborted', cancel);
      req.on('error', cancel);
      res.on('close', () => { if (!res.writableFinished) cancel(); });
      req.pipe(limiter).pipe(upstream);
    }
  });
  server.requestTimeout = idleTimeoutMs;
  server.headersTimeout = Math.min(60000, idleTimeoutMs);
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}
