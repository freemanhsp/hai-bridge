export function validateProcessStopOptions({ graceMs = 2000, killMs = 1000 } = {}) {
  for (const value of [graceMs, killMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 30000) throw new Error('Invalid owned process stop timeout');
  }
  return { graceMs, killMs };
}

// Owns exactly one ChildProcess. No PID lookup, process-name scan or tree takeover.
export function ownProcess(child, options) {
  const { graceMs, killMs } = validateProcessStopOptions(options);
  let closed = false, exited = false, spawnFailed = false, spawned = Boolean(child.pid), stopping;
  let resolveClosed, resolveResult;
  const closedTask = new Promise(resolve => { resolveClosed = resolve; });
  const result = new Promise(resolve => { resolveResult = resolve; });
  const onSpawn = () => { spawned = true; };
  const onExit = () => { exited = true; };
  const onError = () => {
    if (!spawned && !child.pid) spawnFailed = true;
    resolveResult({ code: 1, reason: 'spawn_error' });
  };
  const onClose = code => {
    closed = true; exited = true;
    resolveClosed(); resolveResult({ code: code ?? 255 });
    dispose();
  };
  function dispose() {
    child.removeListener('spawn', onSpawn); child.removeListener('exit', onExit);
    child.removeListener('close', onClose);
    // Keep an error sink until close if cleanup failed; late errors must not crash the owner.
    if (closed) child.removeListener('error', onError);
  }
  child.once('spawn', onSpawn); child.once('exit', onExit);
  child.on('error', onError); child.once('close', onClose);
  const live = () => !closed && !exited && !spawnFailed && child.exitCode == null && child.signalCode == null;
  const signal = name => {
    if (!live()) return;
    try { child.kill(name); } catch { /* Await close; failure never licenses killing a different PID. */ }
  };
  const waitClosed = async ms => {
    if (closed) return true;
    let timer;
    try { return await Promise.race([closedTask.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const stop = () => stopping ??= (async () => {
    if (closed) return;
    signal('SIGTERM');
    if (await waitClosed(graceMs)) return;
    signal('SIGKILL');
    if (await waitClosed(killMs)) return;
    dispose();
    const error = new Error('Owned SSH cleanup did not finish; no foreign process was stopped');
    error.code = 'SSH_STOP_TIMEOUT'; throw error;
  })();
  return { result, stop, live, get closed() { return closed; } };
}
