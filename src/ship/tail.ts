import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { recordGuard, recordLimit } from "./record-limit";

export type Line = { offset: number; bytes: number; text: string };
export type ReadResult = { lines: Line[]; nextOffset: number; raw: Buffer };

const NL = 0x0a;

/**
 * Read complete `\n`-terminated lines from `offset`, about `budget` bytes, ending on a line boundary.
 * A trailing line without `\n` is still being written and is left for the next read.
 * A single line larger than the budget is read whole. Unset bounds preserve legacy uncapped reads.
 */
export function readCompleteLines(path: string, offset: number, budget: number, maxRecordBytes?: number): ReadResult {
  if (maxRecordBytes !== undefined) recordLimit(maxRecordBytes);
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset >= size) return { lines: [], nextOffset: offset, raw: Buffer.alloc(0) };
    const window = Math.max(1, Math.min(budget, size - offset));
    const ceiling = maxRecordBytes === undefined ? Infinity : Math.max(window, maxRecordBytes + 1);
    let want = window;
    let buf: Buffer;
    let end: number;
    for (;;) {
      buf = Buffer.allocUnsafe(want);
      const n = readSync(fd, buf, 0, want, offset);
      buf = buf.subarray(0, n);
      if (maxRecordBytes !== undefined) recordGuard(maxRecordBytes)(buf);
      end = buf.lastIndexOf(NL);
      if (end >= 0 || offset + n >= size) break;
      want = Math.min(want * 2, ceiling, size - offset);
    }
    if (end < 0) return { lines: [], nextOffset: offset, raw: Buffer.alloc(0) };
    return splitLines(buf.subarray(0, end + 1), offset);
  } finally {
    closeSync(fd);
  }
}

export function splitLines(raw: Buffer, offset: number): ReadResult {
  const lines: Line[] = [];
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf(NL, start);
    if (nl < 0) break;
    if (nl > start) lines.push({ offset: offset + start, bytes: nl - start + 1, text: raw.toString("utf8", start, nl) });
    start = nl + 1;
  }
  return { lines, nextOffset: offset + raw.length, raw };
}
