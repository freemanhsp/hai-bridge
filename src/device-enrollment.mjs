import { EventEmitter } from 'node:events';
import { loadApplicationConfig } from './app-config.mjs';
import { runApplication } from './app-runtime.mjs';
import { waitForApplication } from './app-readiness.mjs';

// One bounded foreground pairing operation; owns and cleans only its own B listener/SSH.
export async function enrollDevice(file, { signals = process, onEvent = () => {}, runtimeOptions = {}, timeoutMs = 20000 } = {}) {
  const config = await loadApplicationConfig(file, 'client');
  if (config.transport !== 'app-device') throw new Error('enroll-device requires a v2 device client');
  const owned = new EventEmitter(), abort = new AbortController();
  let service, ended = false, failure, result, code;
  let ready; const listening = new Promise(resolve => { ready = resolve; });
  const stop = () => { abort.abort(); owned.emit('SIGTERM'); };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  const task = runApplication(config, { ...runtimeOptions, signals: owned, onEvent,
    onListening(value) { service = value; ready(); } }).then(value => { code = value; ended = true; }, error => { failure = error; ended = true; abort.abort(); });
  try {
    await Promise.race([listening, task]);
    if (!service || ended || abort.signal.aborted) throw new Error('Device enrollment startup unavailable');
    await waitForApplication(config, { signal: abort.signal, shouldStop: () => ended, timeoutMs });
    result = await service.enroll();
  } finally {
    stop(); await task; signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
  if (failure) throw failure;
  if (code !== 0) throw new Error('Device enrollment SSH cleanup failed');
  return result;
}
