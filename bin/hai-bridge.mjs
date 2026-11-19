#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { initializeServer, loadServerConfig, loadClientConfig, exportClient, credentialReaders,
  DEFAULT_CLIENT_CONFIG, DEFAULT_SERVER_CONFIG } from '../src/config.mjs';
import { createBridge } from '../src/bridge.mjs';
import { runTunnel } from '../src/tunnel.mjs';
import { clientOrigin, diagnose, probeInference, runCodex } from '../src/client.mjs';

const HELP = `HAI Bridge MVP — Node.js 22+

  init-server  [--server-config PATH] [--upstream-url URL] [--upstream-auth-file PATH]
  pair         --ssh-target USER@MAC [--out PATH] [--local-port PORT] [--model MODEL]
  serve        [--server-config PATH]
  connect      [--client-config PATH]
  doctor       [--client-config PATH] [--base-url URL]
  probe        [--client-config PATH] [--base-url URL] [--infer] [--model MODEL]
  codex        [--client-config PATH] [--base-url URL] -- [CODEX ARGS...]

Default server config: .local/server.json
Default client config: .local/client.json
Credentials are not printed. 'probe --infer' makes one small, billable model request.
`;

async function main() {
  const raw = process.argv.slice(2);
  const command = raw.shift();
  const separator = raw.indexOf('--');
  const userArgs = separator === -1 ? [] : raw.slice(separator + 1);
  const options = separator === -1 ? raw : raw.slice(0, separator);
  const { values, positionals } = parseArgs({ args: options, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, infer: { type: 'boolean' },
    'server-config': { type: 'string' }, 'client-config': { type: 'string' },
    'upstream-url': { type: 'string' }, 'upstream-auth-file': { type: 'string' },
    'ssh-target': { type: 'string' }, 'local-port': { type: 'string' },
    out: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
  } });
  if (!command || command === 'help' || command === '--help' || command === '-h' || values.help) {
    console.log(HELP); return;
  }
  if (positionals.length) throw new Error('Unexpected positional arguments; pass Codex arguments after --');
  const serverFile = values['server-config'] || DEFAULT_SERVER_CONFIG;
  const clientFile = values['client-config'] || DEFAULT_CLIENT_CONFIG;
  if (command === 'init-server') {
    const file = await initializeServer(serverFile, {
      upstreamUrl: values['upstream-url'], upstreamAuthFile: values['upstream-auth-file'],
    });
    console.log(`Server configuration created: ${file} (token stored separately, not printed)`);
    return;
  }
  if (command === 'pair') {
    const file = await exportClient(serverFile, values.out || DEFAULT_CLIENT_CONFIG, {
      sshTarget: values['ssh-target'], localPort: values['local-port'] ? Number(values['local-port']) : undefined,
      model: values.model,
    });
    console.log(`Client pairing file created: ${file}`);
    console.log('Transfer only this private pairing file to B; it contains the bridge token, not the HAI key.');
    return;
  }
  if (command === 'serve') {
    const config = await loadServerConfig(serverFile);
    const readers = credentialReaders(config);
    await readers.getBridgeToken();
    await readers.getUpstreamKey();
    const server = createBridge({ ...config, ...readers, logger: value => console.log(JSON.stringify(value)) });
    server.listen(config.listenPort, config.listenHost);
    await once(server, 'listening');
    console.log(`Bridge listening on http://${config.listenHost === '::1' ? '[::1]' : config.listenHost}:${config.listenPort}`);
    console.log(`HAI upstream: ${config.upstream.origin}. Use connect on B to establish the SSH tunnel.`);
    let shuttingDown = false;
    const stop = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const timer = setTimeout(() => server.closeAllConnections(), 5000);
      timer.unref();
      server.close(() => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
      server.closeIdleConnections();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (!['connect', 'doctor', 'probe', 'codex'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const config = await loadClientConfig(clientFile);
  const origin = clientOrigin(config, values['base-url']);
  if (command === 'connect') { process.exitCode = await runTunnel(config); return; }
  if (command === 'doctor' || (command === 'probe' && !values.infer)) {
    console.log(JSON.stringify(await diagnose(config, origin), null, 2)); return;
  }
  if (command === 'probe') {
    console.log(JSON.stringify(await probeInference(config, origin, values.model), null, 2)); return;
  }
  process.exitCode = await runCodex(config, origin, userArgs);
}

main().catch(error => {
  // Never print configuration contents, credentials, request headers, or raw upstream bodies.
  console.error(`HAI Bridge: ${error.code === 'EEXIST' ? 'Output file already exists; choose another path' : error.message}`);
  process.exitCode = 1;
});
