import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../../src/metadata/run";
import { hash } from "../../src/metadata/stream";

for (const mode of ["collision", "past-EOF", "sidecar"] as const) {
  test(`R2-F1 raw upstream receipts reject ${mode} before output creation`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "raw-receipt-")), path = join(dir, "input");
    const raw = '{"type":"session_meta","payload":{"id":"synthetic"}}\n';
    writeFileSync(path, raw);
    const coordinatesPath = join(dir, "coordinates"), out = join(dir, "out");
    const mapping = JSON.stringify({ originalLFLine: 1, decodedOffset: 0,
      recordHash: hash(raw), recordBytes: Buffer.byteLength(raw) }) + "\n";
    writeFileSync(coordinatesPath, mapping);
    const source = { path, inputSha256: hash(raw), memberHash: hash(raw), physicalRepresentationHash: hash(raw),
      format: "raw", provider: "codex", admission: "synthetic", custodyMachine: "synthetic",
      originMachine: "UNKNOWN", originProof: "UNKNOWN", containerDriveId: "UNKNOWN", containerHash: "UNKNOWN",
      memberPath: "synthetic.jsonl", upstreamUninspected: [{ line: mode === "past-EOF" ? 999 : 1,
        bytes: Buffer.byteLength(raw), sha256: hash(raw) }],
      ...(mode === "sidecar" ? { coordinatesPath, coordinatesSha256: hash(mapping) } : {}) };
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, scope: "synthetic", sources: [source] }));
    await expect(project(manifest, out)).rejects.toThrow("OMISSION_RECEIPT_INVALID");
    expect(existsSync(out)).toBe(false);
  });
}
