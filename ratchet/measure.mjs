// Fixed synthetic measurements; a missing parser match always fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';

import { join } from 'node:path';
import { createHash } from 'node:crypto';
const mode = process.argv[2];
if (mode === 'tla' && createHash('sha256').update(readFileSync(process.env.TLA_JAR)).digest('hex') !== 'fc6878c603f0fdc18b9fe3e5bf51860cb90ab5b1154e3c371660c036d6bdd63e') throw Error('TLC checksum mismatch');
mkdirSync('.local', { recursive: true });
const meta = mkdtempSync(join(process.cwd(), '.local/tokenlayer-tlc-'));
const integrationFiles = mode === 'integration' ? ['tests/integration', 'tests/archaeology'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.it.test.ts')).map(name => join(dir, name))) : [];
const args = mode === 'unit' ? ['bun', 'test'] : mode === 'integration' ? ['bun', 'test', ...integrationFiles]
  : mode === 'redactor' ? ['bun', new URL('../scripts/bench-redact.ts', import.meta.url).pathname]
  : ['java', '-cp', process.env.TLA_JAR, 'tlc2.TLC', '-metadir', meta, '-workers', '1', '-config', 'spec/Admit.cfg', 'spec/Admit.tla'];
const run = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
rmSync(meta, { recursive: true, force: true });
const output = (run.stdout ?? '') + (run.stderr ?? '');
if (run.status !== 0) { console.error(output); process.exit(1); }
let value;
if (mode === 'integration' || mode === 'unit') {
  if (mode === 'integration' && !/\b0 skip\b/.test(output) && /\b[1-9]\d* skip\b/.test(output)) throw Error('integrations skipped');
  value = Number(output.match(/\b(\d+) pass\b/)?.[1]);
} else if (mode === 'redactor') {
  value = JSON.parse(run.stdout.trim().split('\n').pop()).medianMBps;
} else {
  if (!output.includes('Model checking completed. No error has been found.')) throw Error('missing TLC success');
  value = 1;
}
if (!Number.isFinite(value)) throw Error('missing measurement');
console.log(value);
