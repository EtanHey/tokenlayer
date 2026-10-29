import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRows } from './run-rows.mjs';
import { checkRows } from './guard.mjs';
export function budget(row, baseline) {
  if (row.growth !== undefined || row.allowance !== undefined) {
    if (!Number.isFinite(baseline)) return NaN;
    return baseline + Math.min(baseline * (row.growth ?? Infinity), row.allowance ?? Infinity);
  }
  return row.direction === 'min' && baseline !== undefined
    ? Math.max(row.ceiling, baseline * (1 - (row.maxRegression ?? 0)))
    : row.direction === 'max' && baseline !== undefined ? Math.min(row.ceiling, baseline) : row.ceiling;
}
export function evaluate(row, value, baseline) {
  if (row.direction === 'pass') return value === true;
  if (!Number.isFinite(value) || (baseline !== undefined && !Number.isFinite(baseline))) return false;
  return row.direction === 'min' ? value >= budget(row, baseline) : value <= budget(row, baseline);
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
      || (r.maxRegression !== undefined && (r.direction !== 'min' || !Number.isFinite(r.maxRegression) || r.maxRegression < 0 || r.maxRegression >= 1))
      || ['growth', 'allowance'].some(k => r[k] !== undefined && (r.direction !== 'max' || !Number.isFinite(r[k]) || r[k] < 0))
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
  const measureRef = process.env.RATCHET_MEASURE_REF || baseRef;
  git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const scratchRoot = resolve('.local');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'tokenlayer-ratchet-'));
  try {
    const archive = git(['archive', measureRef]);
    if (spawnSync('tar', ['-x', '-C', scratch], { input: archive }).status !== 0) throw Error('extract base failed');
    const policy = git(['show', `${baseRef}:${path}`], { encoding: 'utf8' });
    const baseRows = parseRows(JSON.parse(policy));
    checkRows(baseRows, rows, process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {});
    let baseline = {};
    if (baseRows.some(r => r.runner === 'ci')) {
      const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: scratch, encoding: 'utf8' });
      if (install.status !== 0) throw Error('baseline install failed');
      baseline = runRows(rows.filter(r => r.id !== 'redactor-throughput-mbps'), scratch);
    }
    // Timing uses this harness for both source trees, including first adoption.
    // Avoid executing main's historical benchmark floor or sampling policy.
    const timing = rows.find(r => r.id === 'redactor-throughput-mbps');
    if (timing) {
      const run = spawnSync('node', [fileURLToPath(new URL('./measure.mjs', import.meta.url)), 'redactor'], {
        cwd: scratch, encoding: 'utf8', timeout: timing.timeout_s * 1000,
        env: { ...process.env, REDACT_MODULE: join(scratch, 'src/lib/redact.ts') },
      });
      baseline[timing.id] = run.status === 0 ? Number(run.stdout.trim()) : null;
    }
    const values = runRows(rows, process.cwd());
    let ok = true;
    const lines = ['| row | metric | main | this PR | budget | delta | status |', '|---|---|---|---|---|---|---|'];
    for (const row of rows.filter(r => r.runner === 'ci')) {
      const hasBase = baseRows.length > 0;
      const before = baseline[row.id];
      const pass = (!hasBase || before !== null && before !== undefined && before !== false)
        && evaluate(row, values[row.id], hasBase ? before : undefined);
      ok &&= pass;
      const limit = budget(row, hasBase ? before : undefined);
      const delta = Number.isFinite(values[row.id]) && Number.isFinite(before) ? values[row.id] - before : 'n/a';
      const excess = row.direction === 'min' ? limit - values[row.id] : values[row.id] - limit;
      if (!pass) console.error(`${row.id}: ${Number.isFinite(excess) && Number.isFinite(values[row.id]) ? `+${Number(excess.toFixed(3))} ${row.unit ?? 'units'} ${row.direction === 'min' ? 'below floor' : 'over budget'}` : 'missing measurement'}`);
      lines.push(`| ${[row.id, row.metric, hasBase ? before : 'bootstrap', values[row.id], limit, typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${Number(delta.toFixed(3))}` : delta, pass ? 'PASS' : 'FAIL'].map(cell).join(' | ')} |`);
    }
    for (const row of rows.filter(r => r.runner === 'm1')) lines.push(`| ${[row.id, row.metric, 'pending deploy', 'pending deploy', row.ceiling, 'n/a', 'REPORT ONLY'].map(cell).join(' | ')} |`);
    if (!rows.some(r => r.runner === 'ci')) throw Error('no CI rows');
    if (ok && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `median=${values['redactor-throughput-mbps']}\n`);
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
