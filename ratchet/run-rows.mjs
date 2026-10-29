// Minimal fleet producer: pass = exit zero; numeric = finite last stdout line.
import { spawnSync } from 'node:child_process';
export function runRows(rows, cwd) {
  return Object.fromEntries(rows.filter(r => r.runner === 'ci').map(row => {
    const run = spawnSync('bash', ['-c', row.command], {
      cwd, encoding: 'utf8', timeout: row.timeout_s * 1000, maxBuffer: 16 * 1024 * 1024,
    });
    const last = (run.stdout ?? '').trim().split('\n').pop();
    const value = run.status !== 0 ? null : row.direction === 'pass' ? true
      : last && /^\d+(\.\d+)?$/.test(last) ? Number(last) : null;
    if (value === null) console.error(`${row.id}: failed or missing measurement\n${run.stderr ?? ''}`);
    return [row.id, value];
  }));
}
