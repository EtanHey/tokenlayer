import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "../lib/hash";
import { foldCalls, parseLedgerText, type LedgerLine, type SystemoneCall } from "./ledger";

export const TABLE = "systemone_calls";
const SKIP = new Set(["node_modules", ".git"]);

export type JevDrainOptions = {
  machine: string;
  roots: string[];
  maxDepth: number;
  /** Content hash per reservation_id already confirmed by ClickHouse. */
  statePath: string;
  clickhouse: { insert(table: string, rows: readonly unknown[], dedupToken?: string): Promise<void> };
  dryRun?: boolean;
};

export type JevDrainResult = {
  ledgers: number; lines: number; reservations: number; reconciliations: number; invalid: number;
  duplicates: number; calls: number; inserted: number; unreconciled: number;
};

type State = { version: 1; rows: Record<string, string> };

/** Every `usage.jsonl` under the roots, at most maxDepth directories down, without following symlinks. */
export function findLedgers(roots: string[], maxDepth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name === "usage.jsonl") found.push(join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return [...new Set(found)].sort();
}

function loadState(path: string): State {
  if (!existsSync(path)) return { version: 1, rows: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as State;
  if (parsed.version !== 1 || typeof parsed.rows !== "object") throw new Error(`unrecognised jev drain state in ${path}`);
  return parsed;
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

const rowHash = (row: SystemoneCall) => sha256Hex(JSON.stringify(row));

/**
 * Read every Jev ledger whole (they are small), fold to one row per call, and insert only rows whose
 * content changed since ClickHouse last confirmed them. ReplacingMergeTree(ingested_at) keyed by
 * reservation_id keeps the newest row, so a lost state file re-inserts identical rows that FINAL collapses.
 */
export async function drainOnce(opts: JevDrainOptions): Promise<JevDrainResult> {
  const ledgers: { path: string; lines: LedgerLine[] }[] = [];
  let lines = 0;
  let invalid = 0;
  for (const path of findLedgers(opts.roots, opts.maxDepth)) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const parsed = parseLedgerText(text);
    if (parsed.lines.length === 0) continue; // another tool's usage.jsonl
    ledgers.push({ path, lines: parsed.lines });
    lines += parsed.total;
    invalid += parsed.invalid;
  }
  const { calls, duplicates } = foldCalls(opts.machine, ledgers);
  const state = loadState(opts.statePath);
  const changed = calls.filter((row) => state.rows[row.reservation_id] !== rowHash(row));
  if (changed.length && !opts.dryRun) {
    const hashes = changed.map((row) => `${row.reservation_id}:${rowHash(row)}`);
    await opts.clickhouse.insert(TABLE, changed, `jev:${sha256Hex(hashes.join("\n"))}`);
    for (const row of changed) state.rows[row.reservation_id] = rowHash(row);
    saveState(opts.statePath, state);
  }
  const all = ledgers.flatMap((l) => l.lines);
  return {
    ledgers: ledgers.length, lines,
    reservations: all.filter((l) => l.kind === "reservation").length,
    reconciliations: all.filter((l) => l.kind === "reconciliation").length,
    invalid, duplicates, calls: calls.length,
    inserted: opts.dryRun ? 0 : changed.length,
    unreconciled: calls.filter((c) => c.accounting_quality === "unreconciled").length,
  };
}
