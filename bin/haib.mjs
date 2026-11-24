#!/usr/bin/env node
// Same foreground owner and default resolution as start; no shell/profile mutation.
process.argv.splice(2, 0, 'start');
await import('./hai-bridge.mjs');
