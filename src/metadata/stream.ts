import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from "node:fs";

export const RECORD_CAP = 1024 * 1024;
export const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export type LFRecord = { line: number; offset: number; bytes: number; sha256: string; raw?: Buffer; terminated: boolean };
/** Single descriptor, 64KiB reads, <=1MiB retained per LF record; oversize bytes still hashed. */
export function* records(path: string, summary: { sha256?: string; stable?: boolean; peak: number }): Generator<LFRecord> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const before = fstatSync(fd), fileHash = createHash("sha256");
  if (!before.isFile()) { closeSync(fd); throw new Error("input must be a regular file"); }
  let offset = 0, line = 1, bytes = 0, chunks: Buffer[] = [], recordHash = createHash("sha256");
  const finish = (terminated: boolean): LFRecord => {
    const result = { line: line++, offset, bytes, sha256: recordHash.digest("hex"),
      raw: bytes <= RECORD_CAP ? Buffer.concat(chunks, bytes) : undefined, terminated };
    offset += bytes; bytes = 0; chunks = []; recordHash = createHash("sha256");
    return result;
  };
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      const chunk = buffer.subarray(0, n); fileHash.update(chunk);
      let start = 0;
      while (start < n) {
        const nl = chunk.indexOf(10, start), end = nl < 0 ? n : nl + 1;
        const part = chunk.subarray(start, end); recordHash.update(part); bytes += part.length;
        if (bytes <= RECORD_CAP) {
          chunks.push(Buffer.from(part));
          summary.peak = Math.max(summary.peak, bytes);
        } else chunks = [];
        if (nl >= 0) yield finish(true);
        start = end;
      }
    }
    if (bytes) yield finish(false);
    const after = fstatSync(fd), current = lstatSync(path);
    summary.stable = [after, current].every(s => s.dev === before.dev && s.ino === before.ino &&
      s.size === before.size && s.mtimeMs === before.mtimeMs && s.ctimeMs === before.ctimeMs);
    summary.sha256 = fileHash.digest("hex");
  } finally { closeSync(fd); }
}
