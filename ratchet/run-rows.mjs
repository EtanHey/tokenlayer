// Minimal fleet producer: pass = exit zero; numeric = finite last stdout line.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function runRows(rows, cwd) {
  const runId = randomUUID();
  // A passing `bun test` row hands its output to the unit count, so each tree runs the suite once.
  const scratch = fileURLToPath(new URL('../.local/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const unitOutput = join(scratch, `unit-${runId}.txt`);
  try {
    return Object.fromEntries(rows.filter(r => r.runner === 'ci').map(row => {
      const started = Date.now();
      const run = spawnSync('bash', ['-c', row.command.replace(/^bun ratchet\/r1\.ts /, `bun '${fileURLToPath(new URL('./r1.ts', import.meta.url))}' `).replace(/^node ratchet\/measure\.mjs /, `node '${fileURLToPath(new URL('./measure.mjs', import.meta.url))}' `)], {
        cwd, env: { ...process.env, RATCHET_RUN_ID: runId, RATCHET_UNIT_OUTPUT: unitOutput, REDACT_MODULE: `${cwd}/src/lib/redact.ts` }, encoding: 'utf8', timeout: row.timeout_s * 1000, maxBuffer: 16 * 1024 * 1024,
      });
      if (row.command === 'bun test' && run.status === 0) writeFileSync(unitOutput, (run.stdout ?? '') + (run.stderr ?? ''));
      console.error(`ratchet row ${row.id}: ${((Date.now() - started) / 1000).toFixed(1)}s in ${cwd}`);
      const last = (run.stdout ?? '').trim().split('\n').pop();
      const value = run.status !== 0 ? null : row.direction === 'pass' ? true
        : last && /^\d+(\.\d+)?$/.test(last) ? Number(last) : null;
      if (value === null) console.error(`${row.id}: failed or missing measurement\n${run.stderr ?? ''}`);
      return [row.id, value];
    }));
  } finally { rmSync(unitOutput, { force: true }); }
}
