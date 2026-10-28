import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, statSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import type { ClickHouse } from "../lib/clickhouse";
import { sha256Hex } from "../lib/hash";
import { detectHarness, newFileState, parseLine, type Harness, type SourceKind } from "./parse";
import { loadState, saveState, type CheckpointV1, type CheckpointV2, type FileCheckpoint, type LoadedState, type ShipState } from "./state";
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
  /** Rewrite detection: block size of the shipped-prefix hashes, and bytes of blocks re-verified per file per pass. */
  verifyBlockBytes?: number;
  verifyBytesPerPass?: number;
  log?: (msg: string) => void;
};

export type ShipResult = { files: number; lines: number; bytes: number; resets: number };

const LEGACY_FINGERPRINT_BYTES = 4096;
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

const identityOf = (st: BigIntStats) => `${st.dev}:${st.ino}:${st.birthtimeNs}`;
const generationOf = (identity: string, rewrites: number) => sha256Hex(`${identity}\0${rewrites}`).slice(0, 16);
const hashBytes = (buf: Buffer) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const hashRange = (path: string, start: number, end: number) => hashBytes(readAt(path, start, end - start));

/**
 * Block hashes of [0, cp.offset + chunk.length): the checkpoint's blocks extended by `chunk` (the bytes just shipped,
 * hashed as read, not re-read after the insert). A partial last block is re-hashed with its earlier bytes from disk.
 */
function extendBlocks(path: string, cp: FileCheckpoint, chunk: Buffer): string[] {
  const b = cp.blockBytes;
  const blocks = cp.blocks.slice();
  let start = blocks.length * b;
  if (start > cp.offset) {
    blocks.pop();
    start -= b;
  }
  const before = readAt(path, start, cp.offset - start);
  const data = before.length ? Buffer.concat([before, chunk]) : chunk;
  for (let s = 0; s < data.length; s += b) blocks.push(hashBytes(data.subarray(s, s + b)));
  return blocks;
}

/**
 * Verify the shipped prefix against its block hashes without reading all of it on every pass. A change re-arms a
 * full sweep and checks the head and tail blocks at once; each pass then verifies the next `budget` bytes of blocks,
 * cycling, until one full sweep has passed since the last change. An edit anywhere before the offset is caught
 * within ceil(prefix / budget) passes, and per-file reads stay bounded by budget + 2 blocks.
 */
function verifyPrefix(path: string, cp: FileCheckpoint, changed: boolean, budget: number): { ok: boolean; bytes: number } {
  const n = cp.blocks.length;
  if (n === 0) return { ok: true, bytes: 0 };
  if (changed) cp.sweepLeft = n;
  const check = new Set(changed ? [0, n - 1] : []);
  const sweep = Math.min(cp.sweepLeft, Math.max(1, Math.floor(budget / cp.blockBytes)));
  for (let j = 0; j < sweep; j++) check.add((cp.sweepAt + j) % n);
  cp.sweepAt = (cp.sweepAt + sweep) % n;
  cp.sweepLeft -= sweep;
  let bytes = 0;
  for (const i of check) {
    const start = i * cp.blockBytes;
    const end = Math.min(start + cp.blockBytes, cp.offset);
    bytes += end - start;
    if (hashRange(path, start, end) !== cp.blocks[i]) return { ok: false, bytes };
  }
  return { ok: true, bytes };
}

const defaultHarness = (kind: SourceKind): Harness => (kind === "claude" ? "claude" : "codex");

function freshCheckpoint(path: string, kind: SourceKind, st: BigIntStats, blockBytes: number, rewrites: number, generation?: string): FileCheckpoint {
  const decided = detectHarness(kind, headLines(path));
  const identity = identityOf(st);
  return {
    identity,
    mtime: String(st.mtimeNs),
    offset: 0,
    blockBytes,
    blocks: [],
    sweepAt: 0,
    sweepLeft: 0,
    rewrites,
    generation: generation ?? generationOf(identity, rewrites),
    harnessDecided: decided !== null,
    // birthtime is stable across re-runs, so a line before the first timestamp lands in the same partition.
    parser: newFileState(kind, decided ?? defaultHarness(kind), Math.trunc(Number(st.birthtimeMs) || Number(st.mtimeMs))),
  };
}

/** #2-era fingerprint: hash of the first and last 4 KiB of [0, end). Only used to upgrade v2 checkpoints. */
function legacyFingerprint(path: string, end: number): string {
  const len = Math.min(LEGACY_FINGERPRINT_BYTES, end);
  return sha256Hex(`${end}\0${readAt(path, 0, len).toString("latin1")}\0${readAt(path, end - len, len).toString("latin1")}`);
}

/**
 * Upgrade v1/v2 checkpoints in place. One that still matches its file (same inode, prefix hash unchanged) resumes at
 * its offset and keeps its generation (v1 rows had none: the schema migration gives them ""), so shipped rows are
 * not duplicated. Any other becomes a placeholder that the next pass resets, so the file reships as a new generation.
 * Returns the bytes read to hash the resumed prefixes.
 */
function upgradeState(loaded: LoadedState, blockBytes: number): { state: ShipState; bytes: number } {
  if (loaded.version === 3) return { state: loaded, bytes: 0 };
  const state: ShipState = { version: 3, files: {} };
  let bytes = 0;
  for (const [path, old] of Object.entries(loaded.files) as [string, CheckpointV1 | CheckpointV2][]) {
    let st: BigIntStats;
    try {
      st = statSync(path, { bigint: true });
    } catch {
      continue;
    }
    const cp: FileCheckpoint = { ...freshCheckpoint(path, old.parser.kind, st, blockBytes, 0), identity: "", parser: old.parser };
    const same =
      Number(st.ino) === old.inode &&
      Number(st.size) >= old.offset &&
      ("fingerprint" in old
        ? legacyFingerprint(path, old.offset) === old.fingerprint
        : sha256Hex(readAt(path, 0, old.headLen).toString("latin1")) === old.headHash);
    if (same) {
      for (let at = 0; at < old.offset; at += blockBytes) cp.blocks.push(hashRange(path, at, Math.min(at + blockBytes, old.offset)));
      bytes += old.offset;
      Object.assign(cp, { identity: identityOf(st), mtime: "", offset: old.offset, harnessDecided: old.harnessDecided });
      cp.generation = "generation" in old ? old.generation : "";
    }
    state.files[path] = cp;
  }
  return { state, bytes };
}

/** One pass over every root: ship new complete lines, checkpoint, return counts. Throws on insert failure. */
export async function shipOnce(opts: ShipOptions): Promise<ShipResult> {
  const rate = opts.rateBytesPerSec ?? 5 * 1024 * 1024;
  const batchBytes = opts.batchBytes ?? 4 * 1024 * 1024;
  const saveEveryMs = opts.saveEveryMs ?? 5000;
  const blockBytes = opts.verifyBlockBytes ?? 1024 * 1024;
  const verifyBudget = opts.verifyBytesPerPass ?? 4 * 1024 * 1024;
  const result: ShipResult = { files: 0, lines: 0, bytes: 0, resets: 0 };
  const started = performance.now();
  let lastSave = performance.now();
  const loaded = loadState(opts.statePath);
  const upgraded = upgradeState(loaded, blockBytes);
  const state = upgraded.state;
  let dirty = loaded.version !== 3;
  // Every byte read (shipped, verified or upgraded) counts against the throughput cap.
  let paced = upgraded.bytes;

  const save = () => {
    saveState(opts.statePath, state);
    lastSave = performance.now();
    dirty = false;
  };
  const pace = async () => {
    if (rate <= 0) return;
    const ahead = paced / rate - (performance.now() - started) / 1000;
    if (ahead > 0) await Bun.sleep(ahead * 1000);
  };

  const shipFile = async (path: string, kind: SourceKind) => {
    let st: BigIntStats;
    try {
      st = statSync(path, { bigint: true });
    } catch {
      return;
    }
    const size = Number(st.size);
    const identity = identityOf(st);
    let cp: FileCheckpoint | undefined = state.files[path];
    if (!cp) {
      if (opts.sinceMs !== undefined && Number(st.mtimeMs) < opts.sinceMs) return;
      if (size === 0) return;
    }
    const changed = !cp || size !== cp.offset || identity !== cp.identity || String(st.mtimeNs) !== cp.mtime;
    if (cp && !changed && cp.sweepLeft === 0) return;

    // Verify identity and the shipped prefix before trusting the offset, even when the size is unchanged.
    let rewrites = 0;
    if (cp) {
      let reason = identity !== cp.identity ? "replaced" : size < cp.offset ? "truncated" : "";
      if (!reason) {
        const v = verifyPrefix(path, cp, changed, verifyBudget);
        paced += v.bytes;
        await pace();
        if (!v.ok) reason = "rewritten";
      }
      if (reason) {
        opts.log?.(`reset ${path}: ${reason}`);
        // A different file starts over; a rewrite of the same file is its next generation, so old rows stay.
        rewrites = reason === "replaced" ? 0 : cp.rewrites + 1;
        cp = undefined;
        result.resets++;
      }
    }
    if (cp && !cp.harnessDecided) {
      const decided = detectHarness(kind, headLines(path));
      if (decided && decided !== cp.parser.harness) {
        // Earlier rows carry the default harness; reship the file into the same generation so every row agrees.
        cp = freshCheckpoint(path, kind, st, cp.blockBytes, cp.rewrites, cp.generation);
        result.resets++;
      } else if (decided) {
        cp.harnessDecided = true;
      }
    }
    if (!cp) cp = freshCheckpoint(path, kind, st, blockBytes, rewrites);
    cp.mtime = String(st.mtimeNs);
    state.files[path] = cp;
    dirty = true;

    let shippedFromFile = false;
    for (;;) {
      const { lines, nextOffset, raw } = readCompleteLines(path, cp.offset, batchBytes);
      if (lines.length === 0) break;
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
      const blocks = extendBlocks(path, cp, raw);
      await opts.clickhouse.insert("session_events", rows, token);

      const shippedBytes = nextOffset - cp.offset;
      cp.blocks = blocks;
      cp.parser = parser;
      cp.offset = nextOffset;
      dirty = true;
      shippedFromFile = true;
      result.lines += rows.length;
      result.bytes += shippedBytes;
      paced += shippedBytes;

      await pace();
      if (performance.now() - lastSave > saveEveryMs) save();
    }
    if (shippedFromFile) result.files++;
  };

  try {
    await pace();
    for (const root of opts.roots) {
      for (const path of listJsonl(root.dir)) await shipFile(path, root.kind);
    }
  } finally {
    if (dirty) save();
  }
  return result;
}
