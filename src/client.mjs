import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loopbackUrl } from './config.mjs';

export function clientOrigin(config, override) {
  return loopbackUrl(override || `http://127.0.0.1:${config.localPort}`).origin;
}

export async function diagnose(config, origin) {
  const headers = { Authorization: `Bearer ${config.token}` };
  const health = await fetch(`${origin}/healthz`, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!health.ok) throw new Error(`Bridge health check returned HTTP ${health.status}`);
  const models = await fetch(`${origin}/openai/v1/models`, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!models.ok) throw new Error(`HAI model list returned HTTP ${models.status}`);
  const body = await models.json();
  if (!Array.isArray(body.data)) throw new Error('HAI returned an unexpected model-list format');
  return { bridge: 'ok', hai: 'ok', model_count: body.data.length,
    configured_model_available: body.data.some(model => model.id === config.model) };
}

export async function probeInference(config, origin, model = 'gpt-6-luna') {
  const response = await fetch(`${origin}/openai/v1/responses`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json',
      'User-Agent': 'hai-bridge-mvp-probe/0.1.0' },
    body: JSON.stringify({ model, input: 'Reply only with OK.', max_output_tokens: 64,
      reasoning: { effort: 'low' }, store: false, stream: true }),
  });
  if (!response.ok) throw new Error(`Responses probe returned HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected SSE response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', textLength = 0, completed = false, usage;
  const eventTypes = new Set();
  function consume(line) {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    const event = JSON.parse(value);
    eventTypes.add(event.type);
    if (event.type === 'error' || event.type === 'response.failed') throw new Error('Upstream reported a streaming error');
    if (event.type === 'response.output_text.delta') textLength += event.delta?.length || 0;
    if (event.type === 'response.completed') { completed = true; usage = event.response?.usage; }
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(consume);
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!completed) throw new Error('Stream ended without response.completed');
  return { http_status: response.status, completed, output_characters: textLength,
    event_types: [...eventTypes], input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens };
}

export function codexArguments(config, origin, userArgs) {
  const values = {
    model_provider: 'hai-bridge', model: config.model,
    'model_providers.hai-bridge.name': 'HAI Bridge',
    'model_providers.hai-bridge.base_url': `${origin}/openai/v1`,
    'model_providers.hai-bridge.wire_api': 'responses',
    'model_providers.hai-bridge.env_key': 'HAI_BRIDGE_TOKEN',
    'model_providers.hai-bridge.requires_openai_auth': false,
    'model_providers.hai-bridge.supports_websockets': false,
    web_search: 'disabled', sandbox_mode: 'workspace-write', approval_policy: 'on-request',
    'feedback.enabled': false, 'analytics.enabled': false,
  };
  // Spawn arguments are never interpolated into shell command text.
  const overrides = Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  // Keep the token in this invocation's environment instead of a pre-existing shared daemon.
  const globalArgs = userArgs.includes('--no-daemon') ? [] : ['--no-daemon'];
  const subcommand = userArgs.findIndex(value => ['exec', 'e', 'review', 'resume', 'fork'].includes(value));
  if (subcommand !== -1) {
    return [...globalArgs, ...userArgs.slice(0, subcommand + 1), ...overrides, ...userArgs.slice(subcommand + 1)];
  }
  return [...globalArgs, ...overrides, ...userArgs];
}

async function executableInvocation(env) {
  if (env.HAI_CODEX_EXECUTABLE) {
    const file = path.resolve(env.HAI_CODEX_EXECUTABLE);
    if (/\.[cm]?js$/i.test(file)) return { command: process.execPath, prefix: [file] };
    if (/\.(cmd|bat)$/i.test(file)) throw new Error('Set HAI_CODEX_EXECUTABLE to codex.exe or the npm codex.js entry, not a shell shim');
    return { command: file, prefix: [] };
  }
  if (process.platform !== 'win32') return { command: 'codex', prefix: [] };
  for (const entry of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of [path.join(entry, 'codex.exe'),
      path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) {
      try {
        await fs.access(candidate);
        return candidate.endsWith('.js') ? { command: process.execPath, prefix: [candidate] }
          : { command: candidate, prefix: [] };
      } catch {}
    }
  }
  throw new Error('Cannot find Codex; install @openai/codex with npm or set HAI_CODEX_EXECUTABLE');
}

export async function runCodex(config, origin, userArgs, env = process.env) {
  const invocation = await executableInvocation(env);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefix, ...codexArguments(config, origin, userArgs)], {
      stdio: 'inherit', shell: false, env: { ...env, HAI_BRIDGE_TOKEN: config.token },
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    child.once('error', () => {
      process.removeListener('SIGTERM', stop);
      reject(new Error('Cannot start Codex; check installation and PATH'));
    });
    child.once('exit', (code, signal) => {
      process.removeListener('SIGTERM', stop);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
