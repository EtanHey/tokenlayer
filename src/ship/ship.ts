import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ClickHouse } from "../lib/clickhouse";
import { sha256Hex } from "../lib/hash";
import { detectHarness, newFileState, parseLine, type Harness, type SourceKind } from "./parse";
import { loadState, saveState, type FileCheckpoint, type ShipState } from "./state";
import { readCompleteLines } from "./tail";

export type ShipRoot = { kind: SourceKind; dir: string };

export type ShipOptions = {
  machine: string;
  roots: ShipRoot[];
  clickhouse: ClickHouse;
  statePath: string;
  /** Files without a checkpoint whose mtime is older than this are skipped. */
  sinceMs?: number;
  /** Throughput cap in bytes/s across the whole run; 0 disables it. */
  rateBytesPerSec?: number;
  /** Approximate bytes per insert batch. */
  batchBytes?: number;
  /** Persist the checkpoint at most this often (and always at the end). */
  saveEveryMs?: number;
  log?: (msg: string) => void;
};

export type ShipResult = { files: number; lines: number; bytes: number; resets: number };

const FINGERPRINT_BYTES = 4096;
const HEAD_LINES_BYTES = 64 * 1024;

export function listJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function readAt(path: string, position: number, len: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, position);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function headLines(path: string): string[] {
  return readAt(path, 0, HEAD_LINES_BYTES).toString("utf8").split("\n").slice(0, -1);
}

/** Hash of the first and last FINGERPRINT_BYTES of [0, end): catches rewrites at either end of the shipped range. */
function fingerprint(path: string, end: number): string {
  const len = Math.min(FINGERPRINT_BYTES, end);
  const head = readAt(path, 0, len);
  const tail = readAt(path, end - len, len);
  return sha256Hex(`${end}\0${head.toString("latin1")}\0${tail.toString("latin1")}`);
}

const defaultHarness = (kind: SourceKind): Harness => (kind === "claude" ? "claude" : "codex");

function freshCheckpoint(path: string, kind: SourceKind, st: Stats): FileCheckpoint {
  const decided = detectHarness(kind, headLines(path));
  return {
    inode: st.ino,
    mtimeMs: st.mtimeMs,
    offset: 0,
    fingerprint: "",
    generation: "",
    harnessDecided: decided !== null,
    // birthtime is stable across re-runs, so a line before the first timestamp lands in the same partition.
    parser: newFileState(kind, decided ?? defaultHarness(kind), Math.trunc(st.birthtimeMs || st.mtimeMs)),
  };
}

/** True when the file is no longer the one the checkpoint describes (rotated, rewritten or truncated). */
function replaced(path: string, cp: FileCheckpoint, st: Stats): boolean {
  if (st.ino !== cp.inode || st.size < cp.offset) return true;
  return cp.offset > 0 && fingerprint(path, cp.offset) !== cp.fingerprint;
}

/** One pass over every root: ship new complete lines, checkpoint, return counts. Throws on insert failure. */
export async function shipOnce(opts: ShipOptions): Promise<ShipResult> {
  const state: ShipState = loadState(opts.statePath);
  const rate = opts.rateBytesPerSec ?? 5 * 1024 * 1024;
  const batchBytes = opts.batchBytes ?? 4 * 1024 * 1024;
  const saveEveryMs = opts.saveEveryMs ?? 5000;
  const result: ShipResult = { files: 0, lines: 0, bytes: 0, resets: 0 };
  const started = performance.now();
  let lastSave = performance.now();
  let dirty = false;

  const save = () => {
    saveState(opts.statePath, state);
    lastSave = performance.now();
    dirty = false;
  };

  try {
    for (const root of opts.roots) {
      for (const path of listJsonl(root.dir)) {
        let st: Stats;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        let cp: FileCheckpoint | undefined = state.files[path];
        if (!cp) {
          if (opts.sinceMs !== undefined && st.mtimeMs < opts.sinceMs) continue;
          if (st.size === 0) continue;
        } else if (st.size === cp.offset && st.ino === cp.inode && st.mtimeMs === cp.mtimeMs) {
          continue;
        }

        // Touched since the last pass: verify identity before trusting the offset, even when the size is unchanged.
        if (cp && replaced(path, cp, st)) {
          opts.log?.(`reset ${path}: rotated or truncated`);
          cp = undefined;
          result.resets++;
        }
        if (cp && !cp.harnessDecided) {
          const decided = detectHarness(root.kind, headLines(path));
          if (decided && decided !== cp.parser.harness) {
            // Earlier rows carry the default harness; reship the file so every row agrees.
            cp = undefined;
            result.resets++;
          } else if (decided) {
            cp.harnessDecided = true;
          }
        }
        if (!cp) cp = freshCheckpoint(path, root.kind, st);
        cp.mtimeMs = st.mtimeMs;
        state.files[path] = cp;
        dirty = true;

        let shippedFromFile = false;
        for (;;) {
          const { lines, nextOffset } = readCompleteLines(path, cp.offset, batchBytes);
          if (lines.length === 0) break;
          // A fresh checkpoint starts at offset 0, so lines[0] is the file's first line.
          if (!cp.generation) cp.generation = sha256Hex(lines[0].text).slice(0, 16);
          const parser = structuredClone(cp.parser);
          const rows = lines.map((l) => ({
            machine: opts.machine,
            harness: parser.harness,
            path,
            generation: cp!.generation,
            byte_offset: l.offset,
            line_bytes: l.bytes,
            ...parseLine(l.text, parser),
          }));
          // Deterministic token over the rows themselves: an identical retry is deduplicated server-side,
          // while changed rows for the same range (rewrite, late harness decision) are a new insert.
          const token = sha256Hex(`${opts.machine}\0${path}\0${cp.generation}\0${cp.offset}\0${nextOffset}\0${sha256Hex(JSON.stringify(rows))}`);
          await opts.clickhouse.insert("session_events", rows, token);

          const shippedBytes = nextOffset - cp.offset;
          cp.parser = parser;
          cp.offset = nextOffset;
          cp.fingerprint = fingerprint(path, nextOffset);
          shippedFromFile = true;
          result.lines += rows.length;
          result.bytes += shippedBytes;

          if (rate > 0) {
            const ahead = result.bytes / rate - (performance.now() - started) / 1000;
            if (ahead > 0) await Bun.sleep(ahead * 1000);
          }
          if (performance.now() - lastSave > saveEveryMs) save();
        }
        if (shippedFromFile) result.files++;
      }
    }
  } finally {
    if (dirty) save();
  }
  return result;
}
