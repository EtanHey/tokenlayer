// Fixed synthetic measurements; a missing parser match always fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { join } from 'node:path';
const mode = process.argv[2];
if (!['unit', 'integration', 'redactor'].includes(mode)) throw Error('unknown measurement');
const integrationFiles = mode === 'integration' ? ['tests/integration', 'tests/archaeology'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.it.test.ts')).map(name => join(dir, name))) : [];
const args = mode === 'unit' ? ['bun', 'test'] : mode === 'integration' ? ['bun', 'test', ...integrationFiles]
  : ['bun', new URL('../scripts/bench-redact.ts', import.meta.url).pathname];
// Count from the passing `bun test` row's own output when run-rows recorded it; it is only written on exit zero.
const shared = mode === 'unit' && process.env.RATCHET_UNIT_OUTPUT && existsSync(process.env.RATCHET_UNIT_OUTPUT) ? process.env.RATCHET_UNIT_OUTPUT : undefined;
// Count integrations from that run's JUnit report (deleted on failure) when it covers every selected file.
const junit = mode === 'integration' && process.env.RATCHET_UNIT_JUNIT && existsSync(process.env.RATCHET_UNIT_JUNIT) ? fromJunit(readFileSync(process.env.RATCHET_UNIT_JUNIT, 'utf8')) : undefined;
const run = shared ? { status: 0, stdout: readFileSync(shared, 'utf8'), stderr: '' }
  : junit ? { status: 0, stdout: `${junit.pass} pass\n${junit.skip} skip\n`, stderr: '' }
  : spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
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

// Per selected test case: self-closing is a pass, a TODO is neither (as in Bun's summary), any other <skipped> is a skip.
function fromJunit(xml) {
  const counts = { pass: 0, skip: 0 }, seen = new Set();
  for (const [, attrs, body] of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const file = attrs.match(/\bfile="([^"]*)"/)?.[1];
    if (!integrationFiles.includes(file)) continue;
    seen.add(file);
    if (!body || !/<(skipped|failure|error)\b/.test(body)) counts.pass++;
    else if (/<skipped\b(?![^>]*\bmessage="TODO")/.test(body)) counts.skip++;
  }
  return integrationFiles.every(file => seen.has(file)) ? counts : undefined;
}
