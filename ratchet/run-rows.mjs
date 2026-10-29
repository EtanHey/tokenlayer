// Minimal fleet producer: pass = exit zero; numeric = finite last stdout line.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function runRows(rows, cwd) {
  const runId = randomUUID();
  return Object.fromEntries(rows.filter(r => r.runner === 'ci').map(row => {
    const run = spawnSync('bash', ['-c', row.command.replace(/^bun ratchet\/r1\.ts /, `bun '${fileURLToPath(new URL('./r1.ts', import.meta.url))}' `).replace(/^node ratchet\/measure\.mjs /, `node '${fileURLToPath(new URL('./measure.mjs', import.meta.url))}' `)], {
      cwd, env: { ...process.env, RATCHET_RUN_ID: runId, REDACT_MODULE: `${cwd}/src/lib/redact.ts` }, encoding: 'utf8', timeout: row.timeout_s * 1000, maxBuffer: 16 * 1024 * 1024,
    });
    const last = (run.stdout ?? '').trim().split('\n').pop();
    const value = run.status !== 0 ? null : row.direction === 'pass' ? true
      : last && /^\d+(\.\d+)?$/.test(last) ? Number(last) : null;
    if (value === null) console.error(`${row.id}: failed or missing measurement\n${run.stderr ?? ''}`);
    return [row.id, value];
  }));
}
