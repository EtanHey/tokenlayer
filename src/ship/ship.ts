import { redactText } from "../lib/redact";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { RAW_BYTES, type ClickHouse } from "../lib/clickhouse";
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

/** Stream the entire acknowledged prefix in bounded buffers; never sample the middle away. */
function prefixHash(path: string, end: number, start = 0, hash = createHash("sha256")) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let pos = start; pos < end;) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (!n) throw new Error("file shortened during prefix verification");
      hash.update(buf.subarray(0, n));
      pos += n;
    }
    return hash;
  } finally { closeSync(fd); }
}

const identity = (st: Stats) => sha256Hex(`${st.dev}:${st.ino}:${st.birthtimeMs}`).slice(0, 16);

const defaultHarness = (kind: SourceKind): Harness => (kind === "claude" ? "claude" : "codex");

function freshCheckpoint(path: string, kind: SourceKind, st: Stats): FileCheckpoint {
  const decided = detectHarness(kind, headLines(path));
  return {
    inode: st.ino,
    identity: identity(st),
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    offset: 0,
    fingerprint: "",
    // Returning inodes with a rewritten harness must not replace the original harness's rows.
    generation: sha256Hex(`${identity(st)}:${decided ?? defaultHarness(kind)}`).slice(0, 16),
    harnessDecided: decided !== null,
    // Retain checkpoint compatibility; archive parsing no longer reads carry-forward context.
    parser: newFileState(kind, decided ?? defaultHarness(kind), Math.trunc(st.birthtimeMs || st.mtimeMs)),
  };
}

/** Ship each file independently, save acknowledged progress, then report aggregate failures. */
export async function shipOnce(opts: ShipOptions): Promise<ShipResult> {
  const state: ShipState = loadState(opts.statePath);
  // Separate write-ahead generation record retains revision lineage across progress checkpoint loss.
  const generationPath = `${opts.statePath}.generations`;
  const generations = loadState(generationPath);
  const rate = opts.rateBytesPerSec ?? 5 * 1024 * 1024;
  const batchBytes = opts.batchBytes ?? 4 * 1024 * 1024;
  const saveEveryMs = opts.saveEveryMs ?? 5000;
  const result: ShipResult = { files: 0, lines: 0, bytes: 0, resets: 0 };
  const started = performance.now();
  let lastSave = performance.now();
  let dirty = false;
  const failures: unknown[] = [];

  const save = () => {
    saveState(opts.statePath, state);
    lastSave = performance.now();
    dirty = false;
  };

  try {
    for (const root of opts.roots) {
      for (const path of listJsonl(root.dir)) {
        try {
          let st: Stats;
          try {
            st = statSync(path);
          } catch {
            continue;
          }
          let cp: FileCheckpoint | undefined = state.files[path];
          const recorded = generations.files[path];
          const replay = !cp || (recorded && (recorded.generation !== cp.generation || recorded.offset > cp.offset));
          if (replay && recorded) cp = structuredClone(recorded);
          // Bootstrap the journal for checkpoints created before this version, including unchanged files.
          if (cp && !recorded) {
            generations.files[path] = structuredClone(cp);
            saveState(generationPath, generations);
          }
          if (!cp) {
            if (!state.legacyReplay?.includes(path) && opts.sinceMs !== undefined && st.mtimeMs < opts.sinceMs) continue;
            if (st.size === 0) continue;
          } else if (!replay && st.size === cp.offset && identity(st) === cp.identity && st.mtimeMs === cp.mtimeMs && st.ctimeMs === cp.ctimeMs) {
            continue;
          }

          // Touched since the last pass: verify identity before trusting the offset, even when the size is unchanged.
          let hash = createHash("sha256");
          const sameFile = cp && identity(st) === cp.identity && st.size >= cp.offset;
          if (sameFile) hash = prefixHash(path, cp.offset);
          if (cp && (!sameFile || (cp.offset > 0 && hash.copy().digest("hex") !== cp.fingerprint))) {
            opts.log?.(redactText(`reset ${path}: rotated or truncated`));
            const revision = identity(st) === cp.identity
              ? sha256Hex(`${cp.generation}:${prefixHash(path, st.size).digest("hex")}`).slice(0, 16)
              : freshCheckpoint(path, root.kind, st).generation;
            cp = freshCheckpoint(path, root.kind, st);
            cp.generation = revision;
            hash = createHash("sha256");
            result.resets++;
          } else if (cp && replay) {
            const generation = cp.generation;
            cp = freshCheckpoint(path, root.kind, st);
            cp.generation = generation;
            hash = createHash("sha256");
          }
          if (cp && !cp.harnessDecided) {
            const decided = detectHarness(root.kind, headLines(path));
            if (decided && decided !== cp.parser.harness) {
              // Earlier rows carry the default harness; reship the file so every row agrees.
              const generation = cp.generation;
              cp = freshCheckpoint(path, root.kind, st);
              cp.generation = generation;
              hash = createHash("sha256");
              result.resets++;
            } else if (decided) {
              cp.harnessDecided = true;
            }
          }
          if (!cp) cp = freshCheckpoint(path, root.kind, st);
          cp.mtimeMs = st.mtimeMs;
          cp.ctimeMs = st.ctimeMs;
          state.files[path] = cp;
          dirty = true;

          let shippedFromFile = false;
          for (;;) {
            const { lines, nextOffset, raw } = readCompleteLines(path, cp.offset, batchBytes);
            if (lines.length === 0) break;
            // A fresh checkpoint starts at offset 0, so lines[0] is the file's first line.

            const parser = structuredClone(cp.parser);
            const rows = lines.map((l) => ({
              machine: opts.machine,
              harness: parser.harness,
              path,
              generation: cp!.generation,
              byte_offset: l.offset,
              content_hash: createHash("sha256").update(raw.subarray(l.offset - cp!.offset, l.offset - cp!.offset + l.bytes)).digest("hex"),
              line_bytes: l.bytes,
              [RAW_BYTES]: raw.subarray(l.offset - cp!.offset, l.offset - cp!.offset + l.bytes),
              ...parseLine(raw.toString("utf8", l.offset - cp!.offset, l.offset - cp!.offset + l.bytes)),
            }));
            // Deterministic token over the rows themselves: an identical retry is deduplicated server-side,
            // while changed rows for the same range (rewrite, late harness decision) are a new insert.
            const token = sha256Hex(`${opts.machine}\0${path}\0${cp.generation}\0${cp.offset}\0${nextOffset}\0${sha256Hex(JSON.stringify(rows))}`);
            // Hash the exact source buffer used by the parser, before yielding to the insert.
            const nextHash = hash.copy().update(raw);
            const fingerprint = nextHash.copy().digest("hex");
            // Replay progress may trail the verified archive prefix. Never discard its
            // fingerprint: a crash here must still detect rewrites of the archived suffix.
            const protectedPrefix = generations.files[path];
            if (!protectedPrefix || protectedPrefix.generation !== cp.generation || nextOffset >= protectedPrefix.offset) {
              generations.files[path] = { ...cp, offset: nextOffset, fingerprint, parser };
            }
            saveState(generationPath, generations);
            await opts.clickhouse.insert("session_events", rows, token);

            const shippedBytes = nextOffset - cp.offset;
            cp.parser = parser;
            hash = nextHash;
            cp.offset = nextOffset;
            cp.fingerprint = fingerprint;
            state.legacyReplay = state.legacyReplay?.filter((p) => p !== path);
            dirty = true;
            shippedFromFile = true;
            result.lines += rows.length;
            result.bytes += shippedBytes;

            if (rate > 0) {
              const ahead = result.bytes / rate - (performance.now() - started) / 1000;
              if (ahead > 0) await Bun.sleep(ahead * 1000);
            }
            if (performance.now() - lastSave > saveEveryMs) save();
            const after = statSync(path);
            // Re-enter identity verification next pass if the source changed while insertion was pending.
            if (identity(after) !== identity(st) || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) break;
          }
          if (shippedFromFile) result.files++;
        } catch (err) { failures.push(new Error(redactText(err instanceof Error ? err.message : String(err)))); }
      }
    }
  } finally {
    if (dirty) save();
  }
  if (failures.length) throw new AggregateError(failures, "ship failed for some files");
  return result;
}
