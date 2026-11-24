import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { loadApplicationConfig } from './app-config.mjs';
import { resolveDefaultClientFile } from './profiles.mjs';
import { runApplication } from './app-runtime.mjs';
import { waitForApplication } from './app-readiness.mjs';
import { clientOrigin, diagnose, runCodex } from './client.mjs';
import { observe } from './tunnel.mjs';

// One foreground owner for B HTTP, B SSH and the Codex process. Never attaches to foreign listeners.
export async function startSession({ clientFile, profileDir, project, userArgs = [] } = {}, {
  signals = process, onEvent = () => {}, runtimeOptions = {}, env = process.env, codexOptions = {},
  waitOptions = {}, launchCodex = runCodex,
} = {}) {
  const file = clientFile || await resolveDefaultClientFile(profileDir);
  const config = await loadApplicationConfig(file, 'client');
  if (config.mode !== 'hai') throw new Error('start requires a real HAI client; run setup-client using your existing real configuration');
  const cwd = await fs.realpath(path.resolve(project || process.cwd()));
  const privateRoot = await fs.realpath(path.dirname(path.resolve(file)));
  const within = (directory, parent) => { const relative = path.relative(parent, directory); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  if (within(cwd, privateRoot) || within(cwd, await fs.realpath(config.tlsDirectory))) throw new Error('Choose a project outside the private client/pairing directory');
  const runtimeSignals = new EventEmitter(), codexSignals = new EventEmitter(), abort = new AbortController();
  let stopping = false, finishing = false, service, ended = false, runtimeCode, runtimeFailed = false, codexStarted = false, transportLost = false;
  let runtimeReason;
  let resolveListening; const listening = new Promise(resolve => { resolveListening = resolve; });
  const emit = state => observe(onEvent, { event: 'session', state, transport: config.transport, mock: false,
    ...(['stopped', 'cleanup_failed'].includes(state) ? { remote_release: 'not_checked' } : {}) });
  const stop = () => {
    if (stopping) return; stopping = true; abort.abort();
    codexSignals.emit('SIGTERM'); runtimeSignals.emit('SIGTERM');
  };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  let runtimeTask, code = 1;
  try {
    await emit('connecting');
    if (stopping) throw new Error('Startup interrupted');
    runtimeTask = runApplication(config, { ...runtimeOptions, signals: runtimeSignals, onEvent,
      onListening(value) { service = value; resolveListening(); } }).then(value => {
      runtimeCode = value; ended = true;
      if (!finishing && !stopping) { transportLost = codexStarted; abort.abort(); codexSignals.emit('SIGTERM'); }
    }, error => { runtimeReason = error.code; runtimeFailed = true; ended = true; abort.abort(); codexSignals.emit('SIGTERM'); });
    await Promise.race([listening, runtimeTask]);
    if (!service || ended || stopping) throw new Error('Client startup unavailable');
    await waitForApplication(config, { ...waitOptions, signal: abort.signal, shouldStop: () => stopping || ended });
    const result = await diagnose(config, clientOrigin(config), { signal: abort.signal });
    if (result.mock || !result.configured_model_available || stopping || ended) throw new Error('Expected real HAI model is unavailable');
    await emit('ready');
    await emit('codex_starting'); codexStarted = true;
    if (stopping || ended) throw new Error('Startup interrupted');
    code = await launchCodex(config, clientOrigin(config), userArgs, env, { ...codexOptions,
      signals: codexSignals, signal: abort.signal, cwd });
    if (!stopping && (transportLost || runtimeFailed)) await emit('failed');
  } catch {
    await emit(stopping ? 'cancelled' : 'failed').catch(() => {});
    if (!stopping) throw new Error(runtimeReason === 'EADDRINUSE'
      ? 'B application port is already in use; stop your previous owned connect-app/session first. No existing process was stopped.'
      : 'Cannot start session; check paired profile, free B ports, Mac publisher, ECS and Codex installation. No existing process was stopped.');
    code = 130;
  } finally {
    finishing = true; abort.abort(); codexSignals.emit('SIGTERM'); runtimeSignals.emit('SIGTERM');
    try { await runtimeTask; }
    finally { signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop); }
    await emit(['SSH_STOP_TIMEOUT', 'LOCAL_STOP_ERROR'].includes(runtimeReason) ? 'cleanup_failed' : 'stopped');
  }
  if (runtimeFailed || transportLost || (runtimeCode !== undefined && runtimeCode !== 0)) return 1;
  return stopping ? 130 : code;
}
