import { readFileSync } from 'node:fs';

// Resolve against the installed module, never the user's current working directory.
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const PACKAGE_NAME = metadata.name;
export const VERSION = metadata.version;

export function versionInfo() {
  return { name: PACKAGE_NAME, version: VERSION, node_required: metadata.engines.node, node: process.versions.node };
}
