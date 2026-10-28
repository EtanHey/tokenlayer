import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { FileState } from "./parse";

/** Checkpoint for one file: identity, shipped offset, block hashes of the shipped prefix, parser carry-forward. */
export type FileCheckpoint = {
  /** `dev:ino:birthtimeNs` of the file this checkpoint describes; a different value is a different file. */
  identity: string;
  /** mtimeNs when last checked; an unchanged size, identity and mtime (and no sweep left) skips the file unread. */
  mtime: string;
  offset: number;
  /** blocks[i] hashes [i * blockBytes, min((i + 1) * blockBytes, offset)): the whole shipped prefix. */
  blockBytes: number;
  blocks: string[];
  /** Rewrite sweep: next block to verify, and blocks still to verify before a full sweep since the last change. */
  sweepAt: number;
  sweepLeft: number;
  /** Rewrites (truncations, in-place edits) detected for this identity; each one is a new generation. */
  rewrites: number;
  /** Part of the session_events key: hash of identity and rewrites (or carried over from an upgraded checkpoint). */
  generation: string;
  /** False while the file head has no line that decides the harness (detection is retried). */
  harnessDecided: boolean;
  parser: FileState;
};

/** #1-era checkpoint: identity was inode + a hash of the first headLen bytes; rows had no generation. */
export type CheckpointV1 = { inode: number; offset: number; headLen: number; headHash: string; harnessDecided: boolean; parser: FileState };
/** #2-era checkpoint: inode + a hash of the first and last 4 KiB of [0, offset); generation hashed the first line. */
export type CheckpointV2 = Omit<CheckpointV1, "headLen" | "headHash"> & { mtimeMs: number; fingerprint: string; generation: string };

export type ShipState = { version: 3; files: Record<string, FileCheckpoint> };
export type LoadedState =
  | ShipState
  | { version: 2; files: Record<string, CheckpointV2> }
  | { version: 1; files: Record<string, CheckpointV1> };

/** Read the state file. v1 and v2 come back as-is for the shipper to upgrade; anything else is an error naming the fix. */
export function loadState(path: string): LoadedState {
  if (!existsSync(path)) return { version: 3, files: {} };
  let parsed: { version?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = {};
  }
  const v = parsed.version;
  if ((v === 1 || v === 2 || v === 3) && parsed.files && typeof parsed.files === "object") return parsed as LoadedState;
  const tag = typeof v === "number" ? `v${v}` : "bad";
  throw new Error(
    `unrecognised ship state in ${path}. Move it aside and reship: mv ${path} ${path}.${tag}.bak && bun src/ship/main.ts --backfill`,
  );
}

/** Atomic write: temp file, fsync, rename. */
export function saveState(path: string, state: ShipState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
