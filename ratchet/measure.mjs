// Fixed synthetic measurements; a missing parser match always fails.
import { spawnSync } from 'node:child_process';
const mode = process.argv[2];
const args = mode === 'integration' ? ['bun', 'test', 'tests/integration']
  : mode === 'redactor' ? ['bun', new URL('../scripts/bench-redact.ts', import.meta.url).pathname]
  : ['java', '-cp', process.env.TLA_JAR, 'tlc2.TLC', '-workers', '1', '-config', 'spec/Admit.cfg', 'spec/Admit.tla'];
const run = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
const output = (run.stdout ?? '') + (run.stderr ?? '');
if (run.status !== 0) { console.error(output); process.exit(1); }
let value;
if (mode === 'integration') {
  if (!/\b0 skip\b/.test(output) && /\b[1-9]\d* skip\b/.test(output)) throw Error('integrations skipped');
  value = Number(output.match(/\b(\d+) pass\b/)?.[1]);
} else if (mode === 'redactor') {
  value = JSON.parse(run.stdout.trim().split('\n').pop()).medianMBps;
} else {
  value = Number(output.match(/([\d,]+) distinct states found/)?.[1]?.replaceAll(',', ''));
}
if (!Number.isFinite(value)) throw Error('missing measurement');
console.log(value);
