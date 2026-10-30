import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { splitLines, type ReadResult } from "./tail";

/** Backpressure throughout; neither compressed nor decoded files are buffered whole. */
async function* decode(path: string) {
  if (!Bun.which("zstd")) throw new Error("zstd CLI is required for compressed rollouts");
  const proc = Bun.spawn(["zstd", "-qdc", "--", path], { stdout: "pipe", stderr: "ignore" });
  try {
    for await (const chunk of proc.stdout) yield Buffer.from(chunk);
    if (await proc.exited !== 0) throw new Error("zstd decode failed (corrupt, truncated or unreadable stream)");
  } finally {
    proc.kill();
    await proc.exited;
  }
}

export async function compressedHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Validate the entire frame before any insert/checkpoint; verify the old decoded prefix. */
export async function inspectZstd(path: string, prefixEnd: number) {
  const prefix = createHash("sha256"), full = createHash("sha256");
  const head: Buffer[] = [];
  let size = 0, headSize = 0, lineBytes = 0;
  for await (const chunk of decode(path)) {
    for (let start = 0; start < chunk.length;) {
      const nl = chunk.indexOf(10, start);
      const end = nl < 0 ? chunk.length : nl + 1;
      lineBytes += end - start;
      if (lineBytes > 64 * 1024 * 1024) throw new Error("decoded line exceeds 64 MiB limit");
      if (nl >= 0) lineBytes = 0;
      start = end;
    }
    full.update(chunk);
    if (size < prefixEnd) prefix.update(chunk.subarray(0, prefixEnd - size));
    if (headSize < 64 * 1024) {
      const part = chunk.subarray(0, 64 * 1024 - headSize);
      head.push(part); headSize += part.length;
    }
    size += chunk.length;
  }
  return { size, prefix, digest: full.digest("hex"), head: Buffer.concat(head).toString("utf8").split("\n").slice(0, -1) };
}

/** Bounded by one batch plus one line (64 MiB hard limit); offsets are decoded bytes. */
export async function* readZstd(path: string, offset: number, budget: number): AsyncGenerator<ReadResult> {
  let skipped = 0, carry = Buffer.alloc(0);
  const target = Math.min(Math.max(1, budget), 64 * 1024 * 1024);
  for await (const chunk of decode(path)) {
    const skip = Math.min(Math.max(0, offset - skipped), chunk.length);
    skipped += chunk.length;
    carry = Buffer.concat([carry, chunk.subarray(skip)]);
    if (carry.length >= target) {
      const end = carry.lastIndexOf(10) + 1;
      if (end) {
        const raw = carry.subarray(0, end);
        yield splitLines(raw, offset);
        offset += end;
        carry = Buffer.from(carry.subarray(end));
      }
    }
    if (carry.length > 64 * 1024 * 1024) throw new Error("decoded line exceeds 64 MiB limit");
  }
  const end = carry.lastIndexOf(10) + 1;
  if (end) yield splitLines(carry.subarray(0, end), offset);
  // An unterminated tail follows the same archive contract as a live plain file.
}
