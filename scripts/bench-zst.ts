// Fixture-only decoder comparison. Supply a baseline zst.ts beside its tail.ts.
// Example: bun scripts/bench-zst.ts .local/review58/zst-before.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readZstd } from "../src/ship/zst";

const baselinePath = process.argv[2];
if (!baselinePath) throw new Error("supply a baseline zst.ts module path");
const baseline: { readZstd: typeof readZstd } = await import(pathToFileURL(resolve(baselinePath)).href);
const scratch = resolve(".local");
mkdirSync(scratch, { recursive: true });
const path = join(mkdtempSync(join(scratch, "bench-zst-")), "fixture.jsonl.zst");
const line = JSON.stringify({ fixture: "x".repeat(980) }) + "\n";
const count = Math.ceil(150_000_000 / Buffer.byteLength(line));
const input = Buffer.from(line.repeat(count));
writeFileSync(path, Bun.zstdCompressSync(input));
const samples: Record<string, number[]> = { before: [], after: [] };
for (let run = 0; run < 6; run++) {
  for (const [name, read] of [["before", baseline.readZstd], ["after", readZstd]] as const) {
    const started = performance.now();
    let bytes = 0, lines = 0;
    for await (const batch of read(path, 0, 4 * 1024 * 1024)) {
      bytes += batch.raw.length; lines += batch.lines.length;
    }
    const ms = performance.now() - started;
    if (bytes !== input.length || lines !== count) throw new Error("incorrect decoder output");
    const MBps = bytes / ms / 1000;
    if (run) samples[name]!.push(MBps);
    console.log(JSON.stringify({ name, run, warmup: run === 0, bytes, lines, ms, MBps }));
  }
}
for (const [name, values] of Object.entries(samples)) {
  values.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, medianMBps: values[2], minMBps: values[0], maxMBps: values[4] }));
}
