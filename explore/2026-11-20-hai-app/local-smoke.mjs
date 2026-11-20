import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadApplicationConfig } from '../../src/app-config.mjs';
import { loadPair } from '../../src/app-identity.mjs';
import { startHaiClient } from '../../src/app-transport.mjs';
import { diagnose, probeInference } from '../../src/client.mjs';
import { writePrivateFile } from '../../src/config.mjs';
import { VERSION } from '../../src/version.mjs';

const { values } = parseArgs({ options: { 'server-config': { type: 'string' }, out: { type: 'string' }, infer: { type: 'boolean' } } });
let service, report, destination;
try {
  if (!values['server-config'] || !values.out) throw new Error('Explicit server-config/out required');
  const a = await loadApplicationConfig(values['server-config'], 'publisher');
  if (a.mode !== 'hai') throw new Error('Real pairing required');
  destination = path.resolve(values.out);
  report = { version: VERSION, evidence: 'Mac-local-client-TLS-A-real-HAI-not-B-ECS-A', platform: process.platform,
    mock: false, status: 'fail', hai: 'not_called', inference: values.infer ? 'not_attempted' : 'not_requested',
    not_checked: ['Windows_B_ECS_A', 'WSL', 'real_AI_tool_session', 'A_outer_link_recovery', 'VPN_sleep_resume'] };
  await writePrivateFile(destination, JSON.stringify(report, null, 2));
  const pair = await loadPair(a.tlsDirectory, 'client', { mode: 'hai' });
  service = await startHaiClient(pair, { tlsPort: a.appPort, token: a.token });
  report.hai = 'models_attempted';
  const models = await diagnose(a, service.origin);
  if (models.mock || !models.configured_model_available) throw new Error('Model mismatch');
  report.hai = 'models_ok'; report.models = { count: models.model_count, configured_model_available: true };
  if (values.infer) {
    console.error('BILLABLE: one fixed short Responses request through local application TLS; no retry.');
    report.inference = 'attempted';
    const result = await probeInference(a, service.origin, a.model);
    report.inference = 'completed'; report.hai = 'inference_ok';
    report.http_status = result.http_status;
    report.usage = { input_tokens: result.input_tokens, output_tokens: result.output_tokens };
  }
  report.status = values.infer ? 'pass' : 'models-only';
} catch {
  if (report) report.status = 'fail';
  console.error('Local HAI smoke failed; inspect safe stages, never print auth or upstream body.');
  process.exitCode = 1;
} finally {
  await service?.close();
  if (report && destination) {
    // Only update the exclusively reserved file, not an existing user report.
    if (report.hai !== 'not_called') await fs.writeFile(destination, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, inference: report.inference, report_file: destination }));
  }
}
