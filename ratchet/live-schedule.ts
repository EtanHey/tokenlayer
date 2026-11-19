// M1 launchd job (every 15 min): run the live ratchet rows and append one outbox line per row per state change.
// TOKENLAYER_RATCHET_OUTBOX is required (no default, so tests never touch the real outbox).
// TOKENLAYER_RATCHET_OVERRIDE='{"row_id": value}' replaces measurements for a forced proof run; never real data.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error untyped ratchet judge
import { evaluate, parseRows } from './table.mjs';

export type Row = { id: string; command: string; runner: string; direction: 'min' | 'max' | 'pass'; ceiling: number; unit?: string; timeout_s: number };
export type Result = { row: Row; value: number | null; override?: boolean };
export type State = Record<string, 'fail' | 'pass'>;
const LIVE = /^bun ratchet\/live\.ts ([\w.-]+)$/;

export const liveRows = (rows: Row[]) => rows.filter(r => r.runner === 'm1' && LIVE.exec(r.command)?.[1] === r.id);

export function plan(results: Result[], previous: State, now: Date) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const state: State = {}, lines: string[] = [];
  for (const { row, value, override } of results) {
    const status = value !== null && evaluate(row, value) ? 'pass' : 'fail';
    state[row.id] = status;
    if (status === (previous[row.id] ?? 'pass')) continue;
    const shown = value === null ? 'MISSING' : String(Number(value.toFixed(3)));
    const limit = `${row.direction === 'min' ? '≥' : '≤'} ${row.ceiling}${row.unit ? ` ${row.unit}` : ''}`;
    lines.push(`### tokenlayer-ratchet → @tokenlayer-lead @orc — ${stamp} ${status === 'fail' ? 'FAIL' : 'cleared'} ${row.id}: value ${shown}, threshold ${limit}${override ? ' (override)' : ''}`);
  }
  return { lines, state };
}

function measure(row: Row, repo: string): number | null {
  const run = Bun.spawnSync([process.execPath, 'ratchet/live.ts', row.id], { cwd: repo, timeout: row.timeout_s * 1000, stdout: 'pipe', stderr: 'pipe' });
  const last = run.stdout.toString().trim().split('\n').pop() ?? '';
  // Only the exit status is logged: probe errors may carry connection details.
  if (run.exitCode !== 0 || !/^\d+(\.\d+)?(e[+-]?\d+)?$/.test(last)) { console.error(`${row.id}: measurement failed (exit ${run.exitCode})`); return null; }
  return Number(last);
}

export function main(env = process.env, now = new Date()) {
  const outbox = env.TOKENLAYER_RATCHET_OUTBOX;
  if (!outbox) throw Error('TOKENLAYER_RATCHET_OUTBOX must name the outbox file');
  const statePath = env.TOKENLAYER_RATCHET_STATE || join(homedir(), '.config/tokenlayer/ratchet-live-state.json');
  const repo = join(import.meta.dir, '..');
  const overrides: Record<string, number | null> = env.TOKENLAYER_RATCHET_OVERRIDE ? JSON.parse(env.TOKENLAYER_RATCHET_OVERRIDE) : {};
  const rows = liveRows(parseRows(JSON.parse(readFileSync(join(repo, 'ratchet/rows.json'), 'utf8'))));
  let previous: State = {};
  try { previous = JSON.parse(readFileSync(statePath, 'utf8')).rows ?? {}; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const results = rows.map(row => row.id in overrides ? { row, value: overrides[row.id]!, override: true } : { row, value: measure(row, repo) });
  const { lines, state } = plan(results, previous, now);
  // Append before saving state: a failed append is retried next run, never lost.
  if (lines.length) appendFileSync(outbox, lines.map(line => `\n${line}\n`).join(''));
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(`${statePath}.tmp`, JSON.stringify({ updated_at: now.toISOString(), rows: state }, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${statePath}.tmp`, statePath);
  console.log(JSON.stringify({ at: now.toISOString(), posted: lines.length, fail: Object.keys(state).filter(id => state[id] === 'fail') }));
}

if (import.meta.main) {
  try { main(); } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
