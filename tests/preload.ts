import { afterAll } from 'bun:test';
import { CLICKHOUSE_SKIP_REASON, clickhouseAbsent, clickhouseSkips } from './support/clickhouse-gate';
import { prewarmLocalClickHouse, stopPrewarmedLocalClickHouse } from '../src/lib/local-clickhouse';

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

// CI3: each real-ClickHouse test still gets its own fresh server, but the next one starts (and runs its
// `prepare`, e.g. applySchema) while the current test runs, so ~0.5 s start + ~0.3 s schema is mostly
// hidden. TOKENLAYER_CH_PREWARM=0 turns it off. Spares are stopped after the last file and on exit.
if (!clickhouseAbsent) {
  prewarmLocalClickHouse(Number(process.env.TOKENLAYER_CH_PREWARM ?? 2));
  afterAll(() => { stopPrewarmedLocalClickHouse(); });
}
