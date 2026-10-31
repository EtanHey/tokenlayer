// Fixed synthetic measurements; a missing parser match always fails.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

import { join } from 'node:path';
const mode = process.argv[2];
if (!['unit', 'integration', 'redactor'].includes(mode)) throw Error('unknown measurement');
const integrationFiles = mode === 'integration' ? ['tests/integration', 'tests/archaeology'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.it.test.ts')).map(name => join(dir, name))) : [];
const args = mode === 'unit' ? ['bun', 'test'] : mode === 'integration' ? ['bun', 'test', ...integrationFiles]
  : ['bun', new URL('../scripts/bench-redact.ts', import.meta.url).pathname];
const run = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
const output = (run.stdout ?? '') + (run.stderr ?? '');
if (run.status !== 0) { console.error(output); process.exit(1); }
let value;
if (mode === 'integration' || mode === 'unit') {
  if (mode === 'integration' && !/\b0 skip\b/.test(output) && /\b[1-9]\d* skip\b/.test(output)) throw Error('integrations skipped');
  value = Number(output.match(/\b(\d+) pass\b/)?.[1]);
} else if (mode === 'redactor') {
  value = JSON.parse(run.stdout.trim().split('\n').pop()).medianMBps;
}
if (!Number.isFinite(value)) throw Error('missing measurement');
console.log(value);
