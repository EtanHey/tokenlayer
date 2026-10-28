import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { FileState } from "./parse";

/** Checkpoint for one file: identity (inode + head fingerprint), shipped offset, parser carry-forward. */
export type FileCheckpoint = {
  inode: number;
  offset: number;
  headLen: number;
  headHash: string;
  /** False while the file head has no line that decides the harness (detection is retried). */
  harnessDecided: boolean;
  parser: FileState;
};

export type ShipState = { version: 1; files: Record<string, FileCheckpoint> };

export function loadState(path: string): ShipState {
  if (!existsSync(path)) return { version: 1, files: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ShipState;
  if (parsed.version !== 1 || typeof parsed.files !== "object") throw new Error(`unrecognised ship state in ${path}`);
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
