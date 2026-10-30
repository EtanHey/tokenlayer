import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { FileState } from "./parse";

/** Checkpoint for one file: identity (inode, mtime, prefix fingerprint, generation), shipped offset, parser carry-forward. */
export type FileCheckpoint = {
  /** Physical compressed representation; offset/fingerprint remain decoded coordinates. */
  compressed?: { size: number; fingerprint: string; complete: boolean };
  inode: number;
  identity: string;
  /** mtime when last checked; an unchanged size, inode and mtime skips the file without reading it. */
  mtimeMs: number;
  ctimeMs: number;
  offset: number;
  /** sha256 of all bytes in [0, offset). */
  fingerprint: string;
  /** File identity, extended by a revision hash on in-place rewrites; part of the session_events key. */
  generation: string;
  /** False while the file head has no line that decides the harness (detection is retried). */
  harnessDecided: boolean;
  parser: FileState;
};

export type ShipState = { version: 3; files: Record<string, FileCheckpoint>; legacyReplay?: string[] };

export function loadState(path: string): ShipState {
  if (!existsSync(path)) return { version: 3, files: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ShipState;
  if ([1, 2].includes(parsed.version)) {
    // Older fingerprints and generations cannot safely resume. Replay once with file identities.
    const upgraded: ShipState = { version: 3, files: {}, legacyReplay: Object.keys(parsed.files) };
    saveState(path, upgraded);
    return upgraded;
  }
  if (parsed.version !== 3 || typeof parsed.files !== "object") throw new Error(`unrecognised ship state in ${path}`);
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
