import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { generatePair, loadPair, EXPERIMENT } from './certificates.mjs';
import { startMockPublisher, startOpaqueRelay } from './transport.mjs';
import { DEV_TOKEN } from '../../src/dev.mjs';
import { runChecks, portFree } from './checks.mjs';
import { ownedSsh } from './ssh.mjs';
import { writePrivateFile, validatePort } from '../../src/config.mjs';

function parse(argv) {
  const [command, ...rest] = argv, options = {};
  if (!['local', 'publish', 'check'].includes(command)) throw new Error('Use local, publish or check');
  const allowed = command === 'local' ? ['out'] : command === 'publish'
    ? ['pair', 'out', 'target', 'identity', 'known-hosts', 'relay-port', 'app-port']
    : ['pair', 'out', 'target', 'identity', 'known-hosts', 'relay-port', 'tunnel-port'];
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, '');
    if (!rest[i]?.startsWith('--') || !allowed.includes(name) || options[name] !== undefined || !rest[i + 1]) throw new Error('Invalid experiment option');
    options[name] = rest[i + 1];
  }
  for (const name of ['relay-port', 'app-port', 'tunnel-port']) {
    if (options[name] !== undefined) options[name] = validatePort(Number(options[name]), name);
  }
  if (command !== 'local' && !options.pair) throw new Error('Explicit isolated mock pairing required');
  if (command === 'check' && (!options.target || !options.identity || !options['known-hosts'])) throw new Error('Explicit ECS SSH target/identity/trust required');
  if (command === 'publish' && [options.target, options.identity, options['known-hosts']].some(Boolean)
      && ![options.target, options.identity, options['known-hosts']].every(Boolean)) throw new Error('Supply all SSH publisher settings or none');
  return { command, options };
}

export async function main(argv) {
  const { command, options } = parse(argv);
  let publisher, relay, initialRelay, ssh, temporary, stopped = false, resolveStop;
  const stopSignal = new Promise(resolve => { resolveStop = resolve; });
  const stop = () => { stopped = true; resolveStop(); void ssh?.stop().catch(() => {}); void relay?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const output = options.out ? path.resolve(options.out) : undefined;
  // Refuse an existing report before establishing connections or sending mock requests.
  if (output) {
    try { await fs.lstat(output); throw new Error('Report exists; choose a new output file'); }
    catch (error) { if (error.code !== 'ENOENT') { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); throw error; } }
  }
  try {
    if (stopped) throw new Error('Experiment interrupted');
    if (command === 'publish') {
      publisher = await startMockPublisher(await loadPair(options.pair, 'server'), { port: options['app-port'] ?? 18081 });
      if (options.target && !stopped) {
        ssh = ownedSsh({ direction: 'publish', target: options.target, identity: options.identity,
          knownHosts: options['known-hosts'], relayPort: options['relay-port'] ?? 18083, appPort: publisher.port });
        await ssh.start();
      }
      console.log(JSON.stringify({ event: 'mock_application_ready', experiment: EXPERIMENT,
        loopback_port: publisher.port, mac_system_login: 'not_used', ssh_process_started: Boolean(ssh),
        remote_forward: 'verify_from_B', hai: 'not_called' }));
      while (!stopped && (!ssh || ssh.running)) await Promise.race([stopSignal, pause(250)]);
      return stopped || !ssh ? 0 : 1;
    }
    let pair, tlsPort, interrupt, restore;
    if (command === 'local') {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hai-app-tls-local-'));
      const directory = await generatePair(temporary);
      if (stopped) throw new Error('Experiment interrupted');
      pair = await loadPair(directory, 'client');
      publisher = await startMockPublisher(await loadPair(directory, 'server'));
      relay = await startOpaqueRelay(publisher.port, { capture: true });
      initialRelay = relay;
      tlsPort = relay.port;
      interrupt = async () => { await relay.close(); await pause(200); };
      restore = async () => { if (!relay.server.listening && !stopped) relay = await startOpaqueRelay(publisher.port, { port: tlsPort }); };
    } else {
      pair = await loadPair(options.pair, 'client');
      tlsPort = options['tunnel-port'] ?? 18085;
      ssh = ownedSsh({ direction: 'connect', target: options.target, identity: options.identity,
        knownHosts: options['known-hosts'], relayPort: options['relay-port'] ?? 18083, tunnelPort: tlsPort });
      await ssh.start();
      interrupt = async () => { await ssh.stop(); await pause(300); };
      restore = async () => { if (!stopped) await ssh.start(); };
    }
    const report = await runChecks(pair, tlsPort, { interrupt, restore,
      evidence: command === 'local' ? 'local-real-tls-opaque-tcp' : 'B-to-ECS-ssh-application-tls', logger: console.log,
      shouldStop: () => stopped });
    if (initialRelay) {
      const wire = Buffer.concat(initialRelay.captured);
      const noPlaintext = wire.length > 1000 && [DEV_TOKEN, '/openai/v1/responses', 'relay-ok', 'response.output_text.delta']
        .every(value => !wire.includes(Buffer.from(value)));
      report.checks.push({ check: 'opaque-capture-no-application-plaintext', status: noPlaintext ? 'pass' : 'fail' });
      if (!noPlaintext) report.status = 'fail';
    }
    if (ssh) {
      try { await ssh.stop(); await portFree(tlsPort); report.checks.push({ check: 'owned-ssh-stop-releases-port', status: 'pass' }); }
      catch { report.checks.push({ check: 'owned-ssh-stop-releases-port', status: 'fail' }); report.status = 'fail'; }
    }
    if (stopped) report.status = 'interrupted';
    if (output) await writePrivateFile(output, JSON.stringify(report, null, 2) + String.fromCharCode(10));
    console.log(JSON.stringify(report, null, 2));
    return report.status === 'pass' ? 0 : 1;
  } finally {
    await ssh?.stop();
    await relay?.close();
    await publisher?.close();
    // Only the unique directory generated by this invocation; no user-supplied recursive target.
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Mock application TLS experiment failed: check Node/OpenSSL, isolated pair, port availability, ECS key/agent and verified known_hosts. Existing reports are never replaced; no security policy is changed.');
    process.exitCode = 1;
  });
}
