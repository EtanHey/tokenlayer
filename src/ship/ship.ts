import { redactText } from "../lib/redact";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { RAW_BYTES, type ClickHouse } from "../lib/clickhouse";
import { sha256Hex } from "../lib/hash";
import { detectHarness, newFileState, parseLine, type Harness, type SourceKind } from "./parse";
import { loadState, saveState, type FileCheckpoint, type ShipState } from "./state";
import { readCompleteLines } from "./tail";
import { compressedHash, inspectZstd, readZstd, type ZstdSpawner } from "./zst";
import { sanitizeOutput } from "../lib/egress";
import { antigravityCwd, antigravitySession, isAntigravity, parseAntigravity } from "./antigravity";

export type ShipRoot = { kind: SourceKind; dir: string };

export type ShipOptions = {
  zstd?: { spawn?: ZstdSpawner; fingerprint?: typeof compressedHash };
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
let warnedMissingZstd = false;

/** Shared discovery and logical identity for plain files and Codex compressed rollouts. */
export const isSessionPath = (path: string, compressed: boolean) => path.endsWith(".jsonl") || compressed && path.endsWith(".jsonl.zst");
export const logicalSessionPath = (path: string) => path.endsWith(".jsonl.zst") ? path.slice(0, -4) : path;
export const ownsSessionPath = (path: string, compressed: boolean, plainExists = existsSync) =>
  isSessionPath(path, compressed) && (path === logicalSessionPath(path) || !plainExists(logicalSessionPath(path)));

export function listJsonl(dir: string, compressed = false): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p, compressed));
    else if (e.isFile() && ownsSessionPath(p, compressed)) out.push(p);
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

function freshCheckpoint(path: string, kind: SourceKind, st: Stats, head = headLines(path)): FileCheckpoint {
  const decided = detectHarness(kind, head);
  return {
    inode: st.ino,
    identity: identity(st),
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    offset: 0,
    fingerprint: "",
    generation: identity(st),
    harnessDecided: decided !== null,
    // Claude/Codex keep line-local columns; Antigravity seeds its context in fresh().
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
      for (const physical of listJsonl(root.dir, root.kind === "codex")) {
        const agy = isAntigravity(root.kind);
        const session = agy ? antigravitySession(root.dir, physical, root.kind) : "";
        if (agy && !session) continue;
        const compressed = physical.endsWith(".zst");
        if (compressed && !Bun.which("zstd")) {
          if (!warnedMissingZstd) {
            opts.log?.(sanitizeOutput("warning: zstd CLI missing from PATH; skipping compressed rollouts (checkpoints unchanged)"));
            warnedMissingZstd = true;
          }
          continue;
        }
        const path = logicalSessionPath(physical);
        try {
          let st: Stats;
          try {
            st = statSync(physical);
          } catch {
            continue;
          }
          let cp: FileCheckpoint | undefined = state.files[path];
          const recorded = generations.files[path];
          const replay = !cp || (recorded && (recorded.generation !== cp.generation || recorded.offset > cp.offset));
          if (replay && recorded) cp = structuredClone(recorded);
          if (!cp && !state.legacyReplay?.includes(path) && opts.sinceMs !== undefined && st.mtimeMs < opts.sinceMs) continue;
          if (compressed && cp?.compressed?.complete && cp.compressed.size === st.size && identity(st) === cp.identity && cp.mtimeMs === st.mtimeMs && cp.ctimeMs === st.ctimeMs && !replay) continue;
          const packedHash = compressed ? await (opts.zstd?.fingerprint ?? compressedHash)(physical) : undefined;
          const decoded = compressed ? await inspectZstd(physical, cp?.offset ?? 0, opts.zstd?.spawn) : undefined;
          const size = decoded?.size ?? st.size;
          const head = () => decoded?.head ?? headLines(path);
          const fresh = () => {
            const checkpoint = freshCheckpoint(path, root.kind, st, head());
            if (agy) Object.assign(checkpoint.parser, { sessionId: session, cwd: antigravityCwd(root.dir, path, session, root.kind), lastTsMs: 0 });
            if (decoded) checkpoint.generation = decoded.digest.slice(0, 16);
            return checkpoint;
          };
          // Bootstrap the journal for checkpoints created before this version, including unchanged files.
          if (cp && !recorded) {
            generations.files[path] = structuredClone(cp);
            saveState(generationPath, generations);
          }
          if (!cp) {
            if (st.size === 0) continue;
          } else if (!compressed && !replay && !cp.compressed && st.size === cp.offset && identity(st) === cp.identity && st.mtimeMs === cp.mtimeMs && st.ctimeMs === cp.ctimeMs) {
            continue;
          }

          // Touched since the last pass: verify identity before trusting the offset, even when the size is unchanged.
          let hash = createHash("sha256");
          const sameFile = cp && size >= cp.offset && (identity(st) === cp.identity || root.kind === "codex");
          if (sameFile) hash = decoded?.prefix ?? prefixHash(path, cp.offset);
          if (cp && (!sameFile || (cp.offset > 0 && hash.copy().digest("hex") !== cp.fingerprint))) {
            opts.log?.(redactText(`reset ${path}: rotated or truncated`));
            const revision = identity(st) === cp.identity
              ? sha256Hex(`${cp.generation}:${(decoded?.digest ?? prefixHash(path, st.size).digest("hex"))}`).slice(0, 16)
              : fresh().generation;
            cp = fresh();
            cp.generation = revision;
            hash = createHash("sha256");
            result.resets++;
          } else if (cp && replay) {
            const generation = cp.generation;
            cp = fresh();
            cp.generation = generation;
            hash = createHash("sha256");
          }
          if (cp && !cp.harnessDecided) {
            const decided = detectHarness(root.kind, head());
            if (decided && decided !== cp.parser.harness) {
              // Earlier rows carry the default harness; reship the file so every row agrees.
              const generation = cp.generation;
              cp = fresh();
              cp.generation = generation;
              hash = createHash("sha256");
              result.resets++;
            } else if (decided) {
              cp.harnessDecided = true;
            }
          }
          if (!cp) cp = fresh();
          cp.identity = identity(st);
          cp.inode = st.ino;
          cp.compressed = packedHash ? { size: st.size, fingerprint: packedHash, complete: false } : undefined;
          cp.mtimeMs = st.mtimeMs;
          cp.ctimeMs = st.ctimeMs;
          state.files[path] = cp;
          dirty = true;

          let shippedFromFile = false;
          async function* plainBatches(offset: number) {
            for (;;) {
              const chunk = readCompleteLines(path, offset, batchBytes);
              if (!chunk.raw.length) break;
              yield chunk;
              offset = chunk.nextOffset;
            }
          }
          const batches = compressed ? readZstd(physical, cp.offset, batchBytes, opts.zstd?.spawn, decoded?.blocks) : plainBatches(cp.offset);
          for await (const { lines, nextOffset, raw } of batches) {
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
              ...(agy ? parseAntigravity(raw.toString("utf8", l.offset - cp!.offset, l.offset - cp!.offset + l.bytes), parser)
                : parseLine(raw.toString("utf8", l.offset - cp!.offset, l.offset - cp!.offset + l.bytes))),
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
            const after = statSync(physical);
            // Re-enter identity verification next pass if the source changed while insertion was pending.
            if (identity(after) !== identity(st) || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) break;
          }
          if (cp.compressed) {
            cp.compressed.complete = true;
            dirty = true;
          }
          if (shippedFromFile) result.files++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const message = compressed ? `${sanitizeOutput(physical)}: ${sanitizeOutput(reason)}` : redactText(reason);
          failures.push(new Error(message));
        }
      }
    }
  } finally {
    if (dirty) save();
  }
  if (failures.length) throw new AggregateError(failures, "ship failed for some files");
  return result;
}
