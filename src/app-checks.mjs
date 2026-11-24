import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { loadApplicationConfig } from './app-config.mjs';
import { clientTlsOptions } from './app-transport.mjs';
import { runApplication, assertPortFree } from './app-runtime.mjs';
import { runChecks } from './app-protocol-checks.mjs';
import { writePrivateFile } from './config.mjs';

async function tlsReachable(pair, port) {
  return new Promise(resolve => {
    let socket, timer;
    const done = result => { clearTimeout(timer); socket?.destroy(); resolve(result); };
    try {
      socket = tls.connect({ ...clientTlsOptions(pair), host: '127.0.0.1', port }, () => done(socket.authorized));
      socket.on('error', () => done(false));
      timer = setTimeout(() => done(false), 800);
    } catch { done(false); }
  });
}

export async function checkApplicationClient({ clientFile, out, interruptSsh = false }, {
  signals = process, onEvent = () => {}, spawnProcess = spawn,
  runtimeOptions = {}, evidence = 'application-cli-B-ECS-A' } = {}) {
  if (!clientFile || !out) throw new Error('check-app requires --client-config and a new --out');
  const destination = path.resolve(out);
  try { await fs.lstat(destination); throw Object.assign(new Error('Report exists'), { code: 'EEXIST' }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = await loadApplicationConfig(clientFile, 'client');
  if (config.transport !== 'app-tls') throw new Error('check-app currently validates v1 app-tls only; v2 needs its device-auth checks');
  if (config.mode !== 'mock') throw new Error('check-app is mock-only; use try-hai for deliberate real requests');
  if (interruptSsh && (!config.reconnect || config.maxRetries === 0)) throw new Error('Recovery check requires a nonzero bounded retry budget');
  const ownSignals = new EventEmitter();
  let interrupted = false, child, service, runtimeTask, runtimeEnded = false, runtimeCode, runtimeFailed = false;
  let attempt = 0, retrySeen = false, interruptedAttempt = 0, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const stop = () => { interrupted = true; ownSignals.emit('SIGTERM'); };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  const report = { transport: 'app-tls', mock: true, hai: 'not_called', platform: process.platform,
    node: process.versions.node, evidence, status: 'fail', checks: [],
    not_checked: ['A_outer_link_recovery', 'VPN_sleep_resume', 'real_HAI', 'real_AI_tool_session'] };
  const waitReady = async (afterAttempt = 0) => {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline && !interrupted && !runtimeEnded) {
      if (attempt > afterAttempt && await tlsReachable(config.pair, config.tunnelPort)) return;
      await pause(100);
    }
    throw new Error('Application transport not ready');
  };
  try {
    runtimeTask = runApplication(config, { ...runtimeOptions, signals: ownSignals,
      onListening(value) { service = value; resolveReady(); },
      onEvent(event) {
        if (event.event === 'ssh' && event.state === 'starting') attempt = event.attempt;
        if (event.event === 'ssh' && event.state === 'retry_wait') retrySeen = true;
        onEvent(event);
      },
      spawnProcess(command, args, options) {
        child = spawnProcess(command, args, options);
        const current = child;
        current.once('close', () => { if (child === current) child = undefined; });
        return current;
      },
    }).then(code => { runtimeEnded = true; runtimeCode = code; }, () => { runtimeEnded = true; runtimeFailed = true; });
    await Promise.race([ready, runtimeTask]);
    if (!service || interrupted) throw new Error('Application startup interrupted');
    await waitReady();
    const protocols = await runChecks(config.pair, config.tunnelPort, { clientService: service, evidence,
      shouldStop: () => interrupted,
      ...(interruptSsh ? {
        async interrupt() {
          if (!child || runtimeEnded) throw new Error('No owned SSH to interrupt');
          interruptedAttempt = attempt;
          child.kill('SIGTERM'); // Deliberate child failure; controller remains alive and owns recovery.
        },
        async restore() { await waitReady(interruptedAttempt); },
      } : {}),
    });
    report.checks = protocols.checks;
    report.status = protocols.status;
    if (interruptSsh && !retrySeen) {
      report.checks.push({ check: 'automatic-retry-observed', status: 'fail' }); report.status = 'fail';
    } else if (interruptSsh) report.checks.push({ check: 'automatic-retry-observed', status: 'pass' });
  } catch {
    report.checks.push({ check: 'application-startup-and-trust', status: 'fail' });
    report.status = 'fail';
  } finally {
    ownSignals.emit('SIGTERM');
    await runtimeTask;
    if (runtimeFailed || (runtimeCode !== undefined && runtimeCode !== 0)) report.status = 'fail';
    for (const [name, port] of [['owned-http-port-released', config.localPort], ['owned-tls-tunnel-port-released', config.tunnelPort]]) {
      // Do not certify/rebind a port already owned by somebody else when startup failed before our service existed.
      if (!service) { report.checks.push({ check: name, status: 'not-run' }); continue; }
      try { await assertPortFree(port); report.checks.push({ check: name, status: 'pass' }); }
      catch { report.checks.push({ check: name, status: 'fail' }); report.status = 'fail'; }
    }
    if (interrupted) report.status = 'interrupted';
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
  await writePrivateFile(destination, JSON.stringify(report, null, 2));
  return { destination, report };
}
