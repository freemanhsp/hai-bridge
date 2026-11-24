import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { loadApplicationConfig } from './app-config.mjs';
import { clientTlsOptions } from './app-transport.mjs';
import { runApplication, assertPortFree } from './app-runtime.mjs';
import { clientOrigin, diagnose, probeInference } from './client.mjs';
import { writePrivateFile } from './config.mjs';
import { VERSION } from './version.mjs';

async function tlsReady(pair, port) {
  return new Promise(resolve => {
    let socket, timer;
    const done = value => { clearTimeout(timer); socket?.destroy(); resolve(value); };
    try {
      socket = tls.connect({ ...clientTlsOptions(pair), host: '127.0.0.1', port }, () => done(socket.authorized));
      socket.once('error', () => done(false));
      timer = setTimeout(() => done(false), 800);
    } catch { done(false); }
  });
}

// Deliberate real trial, not protocol/fault acceptance. Never retries a model request.
export async function tryHai({ clientFile, out, infer = false }, {
  signals = process, onEvent = () => {}, runtimeOptions = {},
  evidence = 'application-cli-real-HAI-B-ECS-A',
} = {}) {
  if (!clientFile || !out) throw new Error('try-hai requires --client-config and a new --out');
  const destination = path.resolve(out);
  try { await fs.lstat(destination); throw Object.assign(new Error('Report exists'), { code: 'EEXIST' }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = await loadApplicationConfig(clientFile, 'client');
  if (config.transport !== 'app-tls') throw new Error('try-hai currently validates v1 app-tls only; use v2 connect-app and doctor explicitly');
  if (config.mode !== 'hai') throw new Error('try-hai requires a dedicated --hai client, not a mock configuration');
  const report = { transport: 'app-tls', mock: false, version: VERSION, platform: process.platform,
    node: process.versions.node, evidence, status: 'fail', hai: 'not_called',
    inference: infer ? 'not_attempted' : 'not_requested', checks: [],
    not_checked: ['WSL_unless_run_in_WSL', 'A_outer_link_recovery', 'VPN_sleep_resume', 'real_AI_tool_session', 'long_term_stability'] };
  // Claim the report exclusively before any network/cost, including concurrent invocations.
  await writePrivateFile(destination, JSON.stringify(report, null, 2));
  const owned = new EventEmitter();
  let service, ended = false, failed = false, code, interrupted = false, stage = 'startup', resolveListening;
  const listening = new Promise(resolve => { resolveListening = resolve; });
  const stop = () => { interrupted = true; owned.emit('SIGTERM'); };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  let task;
  try {
    task = runApplication(config, { ...runtimeOptions, signals: owned, onEvent,
      onListening(value) { service = value; resolveListening(); } }).then(value => { code = value; ended = true; }, () => { failed = true; ended = true; });
    await Promise.race([listening, task]);
    if (!service || interrupted || ended) throw new Error('Startup unavailable');
    const deadline = performance.now() + 20000;
    let ready = false;
    while (!ended && !interrupted && performance.now() < deadline) {
      if (await tlsReady(config.pair, config.tunnelPort)) { ready = true; break; }
      await pause(100);
    }
    if (!ready || interrupted) throw new Error('TLS unavailable');
    report.checks.push({ check: 'pinned-mtls-ready', status: 'pass' });
    stage = 'models'; report.hai = 'models_attempted';
    const health = await diagnose(config, clientOrigin(config));
    if (health.mock || !health.configured_model_available || interrupted) throw new Error('Real model unavailable');
    report.hai = 'models_ok';
    report.models = { count: health.model_count, configured_model_available: true };
    report.checks.push({ check: 'real-model-list', status: 'pass' });
    if (infer) {
      stage = 'inference'; report.inference = 'attempted';
      const result = await probeInference(config, clientOrigin(config), config.model);
      if (interrupted) throw new Error('Interrupted');
      report.inference = 'completed'; report.hai = 'inference_ok';
      report.usage = { input_tokens: result.input_tokens, output_tokens: result.output_tokens };
      report.checks.push({ check: 'real-responses-sse-completed', status: 'pass' });
    }
    report.status = infer ? 'pass' : 'models-only';
  } catch { report.checks.push({ check: stage, status: 'fail' }); report.status = 'fail'; }
  finally {
    owned.emit('SIGTERM'); await task;
    if (failed || (code !== undefined && code !== 0)) report.status = 'fail';
    for (const [check, port] of [['owned-http-port-released', config.localPort], ['owned-tls-tunnel-port-released', config.tunnelPort]]) {
      if (!service) { report.checks.push({ check, status: 'not-run' }); continue; }
      try { await assertPortFree(port); report.checks.push({ check, status: 'pass' }); }
      catch { report.checks.push({ check, status: 'fail' }); report.status = 'fail'; }
    }
    if (interrupted) report.status = 'interrupted';
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
  await fs.writeFile(destination, JSON.stringify(report, null, 2)); // Only the file created by this invocation.
  return { destination, report };
}
