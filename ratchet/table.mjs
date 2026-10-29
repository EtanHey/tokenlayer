import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRows } from './run-rows.mjs';
export function evaluate(row, value, baseline) {
  if (row.direction === 'pass') return value === true;
  if (!Number.isFinite(value) || (baseline !== undefined && !Number.isFinite(baseline))) return false;
  return row.direction === 'min' ? value >= row.ceiling && (baseline === undefined || value >= baseline)
    : value <= row.ceiling && (baseline === undefined || value <= baseline);
}
export function parseRows(doc) {
  if (doc.schema !== 1 || !doc.rows?.length) throw Error('expected schema 1 and nonempty rows');
  const seen = new Set();
  for (const r of doc.rows) {
    if (!/^[\w.-]+$/.test(r.id) || seen.has(r.id) || !r.metric || !r.command
      || !['real', 'unit'].includes(r.kind) || !['ci', 'm1'].includes(r.runner)
      || !['pass', 'min', 'max'].includes(r.direction)
      || !(Number.isInteger(r.timeout_s) && r.timeout_s > 0)
      || (r.direction === 'pass' ? r.ceiling !== true : !Number.isFinite(r.ceiling))
      || (r.kind === 'real' && ![r.bug_sha, r.fix_sha].every(s => /^[a-f0-9]{7,40}$/.test(s))))
      throw Error(`invalid row ${r.id}`);
    seen.add(r.id);
  }
  return doc.rows;
}
function git(args, options = {}) {
  const p = spawnSync('git', args, { maxBuffer: 32 * 1024 * 1024, ...options });
  if (p.status !== 0) throw Error(`git ${args[0]} failed`);
  return p.stdout;
}
const cell = v => String(v ?? 'MISSING').replaceAll('|', '\\|').replaceAll('\n', ' ');
export function main(path) {
  const rows = parseRows(JSON.parse(readFileSync(path, 'utf8')));
  const baseRef = process.env.RATCHET_BASE_REF || 'origin/main';
  git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const scratch = mkdtempSync(join(tmpdir(), 'tokenlayer-ratchet-'));
  try {
    const archive = git(['archive', baseRef]);
    if (spawnSync('tar', ['-x', '-C', scratch], { input: archive }).status !== 0) throw Error('extract base failed');
    const basePath = join(scratch, path);
    const baseRows = existsSync(basePath) ? parseRows(JSON.parse(readFileSync(basePath, 'utf8'))) : [];
    // Existing rows cannot disappear, change commands, or loosen their thresholds unnoticed.
    for (const old of baseRows) {
      const next = rows.find(r => r.id === old.id);
      if (!next || ['command', 'metric', 'direction', 'runner', 'kind'].some(k => old[k] !== next[k])
        || (old.direction === 'min' && next.ceiling < old.ceiling)
        || (old.direction === 'max' && next.ceiling > old.ceiling)
        || next.timeout_s > old.timeout_s) throw Error(`row removed or loosened: ${old.id}`);
    }
    let baseline = {};
    if (baseRows.some(r => r.runner === 'ci')) {
      const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: scratch, encoding: 'utf8' });
      if (install.status !== 0) throw Error('baseline install failed');
      baseline = runRows(baseRows, scratch);
    }
    const values = runRows(rows, process.cwd());
    let ok = true;
    const lines = ['| row | metric | ceiling | main | this PR | status |', '|---|---|---|---|---|---|'];
    for (const row of rows.filter(r => r.runner === 'ci')) {
      const hasBase = baseRows.some(r => r.id === row.id);
      const before = baseline[row.id];
      const pass = (!hasBase || before !== null && before !== undefined && evaluate(row, before))
        && evaluate(row, values[row.id], hasBase ? before : undefined);
      ok &&= pass;
      lines.push(`| ${[row.id, row.metric, row.ceiling, hasBase ? before : 'bootstrap', values[row.id], pass ? 'PASS' : 'FAIL'].map(cell).join(' | ')} |`);
    }
    if (!rows.some(r => r.runner === 'ci')) throw Error('no CI rows');
    const table = lines.join('\n') + '\n';
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
    return ok ? 0 : 1;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv[2] || 'ratchet/rows.json'); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
