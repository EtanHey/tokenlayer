import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { FileState } from "./parse";

/** Checkpoint for one file: identity (inode, mtime, head+tail fingerprint, generation), shipped offset, parser carry-forward. */
export type FileCheckpoint = {
  inode: number;
  /** mtime when last checked; an unchanged size, inode and mtime skips the file without reading it. */
  mtimeMs: number;
  offset: number;
  /** sha256 of the first and last FINGERPRINT_BYTES of [0, offset). */
  fingerprint: string;
  /** Content identity of this file generation (hash of its first line); part of the session_events key. */
  generation: string;
  /** False while the file head has no line that decides the harness (detection is retried). */
  harnessDecided: boolean;
  parser: FileState;
};

export type ShipState = { version: 2; files: Record<string, FileCheckpoint> };

export function loadState(path: string): ShipState {
  if (!existsSync(path)) return { version: 2, files: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ShipState;
  if (parsed.version !== 2 || typeof parsed.files !== "object") throw new Error(`unrecognised ship state in ${path}`);
  return parsed;
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
