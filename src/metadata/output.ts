import { closeSync, fsyncSync, openSync, renameSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";
export const FLOOR_BYTES = 20 * 1024 ** 3;
// Includes one <=8MiB encoded write and <=16MiB pending scratch transaction.
export const PENDING_BYTES = 24 * 1024 ** 2;
export class ProjectionError extends Error {}
export function reason(error: unknown): string {
  if (error instanceof ProjectionError) return error.message;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" ? "OUTPUT_EXISTS" : code === "ENOENT" ? "INPUT_OR_PARENT_MISSING" :
    code === "ENOSPC" ? "PHYSICAL_SPACE_EXHAUSTED" : "PROJECTION_IO_OR_INPUT_ERROR";
}
/** statfs allocated/free blocks only. No Foundation capacity/purgeable-space estimate. */
export function physicalFree(path: string): number {
  const s = statfsSync(path);
  return Math.min(s.bfree, s.bavail) * s.bsize;
}
export class Budget {
  readonly bytes: number;
  readonly scratchBytes: number;
  used = 0;
  constructor(readonly out: string, readonly maxRows: number, readonly free = () => physicalFree(out)) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000_000) throw new ProjectionError("OUTPUT_ROW_CAP_INVALID");
    this.bytes = maxRows * 64 * 1024;
    this.scratchBytes = 1024 ** 2 + maxRows * 16 * 1024;
    if (free() < FLOOR_BYTES + PENDING_BYTES + this.bytes + this.scratchBytes)
      throw new ProjectionError("PREFLIGHT_SPACE_BUDGET");
  }
  check(bytes = 0) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8 * 1024 ** 2) throw new ProjectionError("OUTPUT_WRITE_CAP");
    if (this.free() < FLOOR_BYTES + PENDING_BYTES + bytes) throw new ProjectionError("PHYSICAL_SPACE_FLOOR");
  }
  account(bytes: number) {
    if (this.used + bytes > this.bytes) throw new ProjectionError("OUTPUT_BYTES_BUDGET");
    this.check(bytes); this.used += bytes;
  }
  write(fd: number, text: string) {
    const data = Buffer.from(text); this.account(data.length);
    let at = 0;
    while (at < data.length) {
      this.check(data.length - at);
      const n = writeSync(fd, data, at, data.length - at);
      if (n <= 0) throw new ProjectionError("OUTPUT_SHORT_WRITE");
      at += n;
    }
  }
  manifest(receipt: unknown) {
    const pending = join(this.out, "manifest.json.pending");
    const fd = openSync(pending, "wx", 0o600);
    try { this.write(fd, JSON.stringify(receipt, null, 2) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.check(); renameSync(pending, join(this.out, "manifest.json"));
  }
}
