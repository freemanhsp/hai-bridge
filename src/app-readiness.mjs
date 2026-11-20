import tls from 'node:tls';
import { setTimeout as pause } from 'node:timers/promises';
import { clientTlsOptions } from './app-transport.mjs';

export async function applicationTlsReady(pair, port, signal) {
  if (signal?.aborted) return false;
  return new Promise(resolve => {
    let socket, timer;
    const abort = () => done(false);
    const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket?.destroy(); resolve(value); };
    try {
      signal?.addEventListener('abort', abort, { once: true });
      socket = tls.connect({ ...clientTlsOptions(pair), host: '127.0.0.1', port }, () => done(socket.authorized));
      socket.once('error', () => done(false));
      timer = setTimeout(() => done(false), 800);
      if (signal?.aborted) done(false);
    } catch { done(false); }
  });
}

export async function waitForApplication(config, { signal, shouldStop = () => false, timeoutMs = 20000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (!signal?.aborted && !shouldStop() && performance.now() < deadline) {
    if (await applicationTlsReady(config.pair, config.tunnelPort, signal)) return;
    await pause(100);
  }
  throw new Error('Application TLS not ready; check Mac publisher, ECS connectivity and paired identity');
}
