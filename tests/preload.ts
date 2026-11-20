import { afterAll } from 'bun:test';
import { CLICKHOUSE_SKIP_REASON, clickhouseAbsent, clickhouseSkips } from './support/clickhouse-gate';

// Agent shells export GIT_EDITOR, and a Git hook exports GIT_DIR and friends. The Gemini output
// guard refuses any GIT_* variable, so an ambient one fails every custody test on the Macs and
// never in CI. Tests that need a Git variable set it themselves. Names only, never values.
// Bun.spawn without `env` passes the startup environment, not this edited process.env, so a
// test that spawns a guarded CLI passes `env: process.env`.
const ambientGit = Object.keys(process.env).filter(name => name.startsWith('GIT_'));
for (const name of ambientGit) delete process.env[name];
if (ambientGit.length) console.error(`[tokenlayer tests] removed ambient ${ambientGit.join(', ')} so tests see a clean Git environment`);

if (clickhouseAbsent) {
  console.error(`[tokenlayer tests] SKIPPING real-ClickHouse integration tests: ${CLICKHOUSE_SKIP_REASON}. Skipped is not passed.`);
  // A preload afterAll runs once, after the last test file.
  afterAll(() => {
    console.error(`\n[tokenlayer tests] SKIPPED ${clickhouseSkips.length} test(s) gated by tests/support/clickhouse-gate.ts (${CLICKHOUSE_SKIP_REASON}):`);
    for (const name of clickhouseSkips) console.error(`  (skip) ${name}`);
    console.error('[tokenlayer tests] Tests gated by skipIf(!clickhouseBinary()) are in the "skip" count only.');
  });
}
