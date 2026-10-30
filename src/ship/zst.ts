import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { splitLines, type ReadResult } from "./tail";

/** Backpressure throughout; neither compressed nor decoded files are buffered whole. */
export const spawnZstd = (path: string) => Bun.spawn(["zstd", "-qdc", "--", path], { stdout: "pipe", stderr: "ignore" });
export type ZstdSpawner = typeof spawnZstd;

// Fixed blocks let the second pass verify bytes against the completed first decode.
async function* decode(path: string, spawn = spawnZstd, blocks?: string[], record = false) {
  if (!Bun.which("zstd")) throw new Error("zstd CLI is required for compressed rollouts");
  const proc = spawn(path);
  let parts: Buffer[] = [], size = 0, index = 0;
  const checked = () => {
    const raw = Buffer.concat(parts, size);
    if (blocks) {
      const digest = createHash("sha256").update(raw).digest("hex");
      if (record) blocks.push(digest);
      else if (blocks[index] !== digest) throw new Error("zstd stream changed after validation");
      index++;
    }
    parts = []; size = 0;
    return raw;
  };
  try {
    for await (const chunk of proc.stdout) {
      for (let start = 0; start < chunk.length;) {
        const end = Math.min(chunk.length, start + 256 * 1024 - size);
        parts.push(Buffer.from(chunk.subarray(start, end)));
        size += end - start; start = end;
        if (size === 256 * 1024) yield checked();
      }
    }
    if (await proc.exited !== 0) throw new Error("zstd decode failed (corrupt, truncated or unreadable stream)");
    if (size) yield checked();
    if (blocks && !record && index !== blocks.length) throw new Error("zstd stream shortened after validation");
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
export async function inspectZstd(path: string, prefixEnd: number, spawn = spawnZstd) {
  const blocks: string[] = [];
  const prefix = createHash("sha256"), full = createHash("sha256");
  const head: Buffer[] = [];
  let size = 0, headSize = 0, lineBytes = 0;
  for await (const chunk of decode(path, spawn, blocks, true)) {
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
  return { blocks, size, prefix, digest: full.digest("hex"), head: Buffer.concat(head).toString("utf8").split("\n").slice(0, -1) };
}

/** Bounded by one batch plus one line (64 MiB hard limit); offsets are decoded bytes. */
export async function* readZstd(path: string, offset: number, budget: number, spawn = spawnZstd, blocks?: string[]): AsyncGenerator<ReadResult> {
  let skipped = 0, size = 0;
  let parts: Buffer[] = [];
  const target = Math.min(Math.max(1, budget), 64 * 1024 * 1024);
  for await (const chunk of decode(path, spawn, blocks)) {
    const skip = Math.min(Math.max(0, offset - skipped), chunk.length);
    skipped += chunk.length;
    const part = chunk.subarray(skip);
    parts.push(part); size += part.length;
    const end = part.lastIndexOf(10) + 1;
    if (size >= target && end) {
      parts[parts.length - 1] = part.subarray(0, end);
      const raw = Buffer.concat(parts, size - part.length + end);
      yield splitLines(raw, offset);
      offset += raw.length;
      const tail = part.subarray(end);
      parts = [tail]; size = tail.length;
    }
    if (size > 64 * 1024 * 1024) throw new Error("decoded line exceeds 64 MiB limit");
  }
  const carry = Buffer.concat(parts, size);
  const end = carry.lastIndexOf(10) + 1;
  if (end) yield splitLines(carry.subarray(0, end), offset);
  // An unterminated tail follows the same archive contract as a live plain file.
}
