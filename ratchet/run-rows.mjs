// Minimal fleet producer: pass = exit zero; numeric = finite last stdout line.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function runRows(rows, cwd) {
  const runId = randomUUID();
  // A passing `bun test` row hands its output and JUnit report to the unit and integration counts, so each tree runs the suite once.
  const scratch = fileURLToPath(new URL('../.local/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const unitOutput = join(scratch, `unit-${runId}.txt`), unitJunit = join(scratch, `unit-${runId}.xml`);
  let suiteFailed = false;
  try {
    return Object.fromEntries(rows.filter(r => r.runner === 'ci').map(row => {
      // A known failed/timed-out suite cannot supply a valid count. Preserve missing
      // measurements without retrying the same expensive failure twice more.
      if (suiteFailed && ['node ratchet/measure.mjs unit', 'node ratchet/measure.mjs integration'].includes(row.command)) {
        console.error(`ratchet row ${row.id}: missing measurement (suite failed; no retry) in ${cwd}`);
        return [row.id, null];
      }
      const started = Date.now();
      const suite = row.command === 'bun test';
      const run = spawnSync('bash', ['-c', suite ? `bun test --reporter=junit --reporter-outfile='${unitJunit}'` : row.command.replace(/^bun ratchet\/r1\.ts /, `bun '${fileURLToPath(new URL('./r1.ts', import.meta.url))}' `).replace(/^node ratchet\/measure\.mjs /, `node '${fileURLToPath(new URL('./measure.mjs', import.meta.url))}' `)], {
        cwd, env: { ...process.env, RATCHET_RUN_ID: runId, RATCHET_UNIT_OUTPUT: unitOutput, RATCHET_UNIT_JUNIT: unitJunit, REDACT_MODULE: `${cwd}/src/lib/redact.ts` }, encoding: 'utf8', timeout: row.timeout_s * 1000, maxBuffer: 16 * 1024 * 1024,
      });
      if (suite) suiteFailed = run.status !== 0;
      if (suite && run.status === 0) writeFileSync(unitOutput, (run.stdout ?? '') + (run.stderr ?? ''));
      else if (suite) rmSync(unitJunit, { force: true });
      const took = (Date.now() - started) / 1000;
      console.error(`ratchet row ${row.id}: ${took.toFixed(1)}s in ${cwd}`);
      // Visible on the run page before a growing row reaches its timeout and fails.
      if (run.status === 0 && took > 0.75 * row.timeout_s) console.log(`::warning title=Ratchet timeout headroom::${row.id} took ${took.toFixed(1)}s of its ${row.timeout_s}s timeout_s`);
      const last = (run.stdout ?? '').trim().split('\n').pop();
      const value = run.status !== 0 ? null : row.direction === 'pass' ? true
        : last && /^\d+(\.\d+)?$/.test(last) ? Number(last) : null;
      if (value === null) console.error(`${row.id}: failed or missing measurement\n${run.stderr ?? ''}`);
      return [row.id, value];
    }));
  } finally { for (const f of [unitOutput, unitJunit]) rmSync(f, { force: true }); }
}
