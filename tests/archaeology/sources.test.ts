import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSources } from "../../src/archaeology/sources";
import { manifest, dryRun, sha256, type Inventory } from "../../src/archaeology/pipeline";
test("local source adapter streams repeated tar members without extracting and decodes zstd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-source-"));
  try {
    mkdirSync(join(dir, "input"));
    const bytes = Buffer.from('{"sessionId":"source-test","type":"user"}\n');
    const file = join(dir, "input", "session.jsonl"), tar = join(dir, "archive.tar.gz"), zst = join(dir, "rollout-session.jsonl.zst");
    writeFileSync(file, bytes);
    expect(Bun.spawnSync(["tar", "-cf", tar, "-C", join(dir, "input"), "session.jsonl"]).exitCode).toBe(0);
    const extra = Buffer.from('{"sessionId":"source-test","type":"assistant"}\n');
    writeFileSync(file, extra); expect(Bun.spawnSync(["tar", "-rf", tar, "-C", join(dir, "input"), "session.jsonl"]).exitCode).toBe(0); writeFileSync(file, bytes);
    // Zstd is optional in CI; tar decoding always runs.
    if (Bun.which("zstd")) expect(Bun.spawnSync(["zstd", "-q", file, "-o", zst]).exitCode).toBe(0);
    const row: Inventory = { machine: "m4", source_kind: "tarball_member", container: tar, member_path: "session.jsonl", session_id: "source-test", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
    const rows = manifest([row, { ...row, sha256: sha256(extra), bytes: String(extra.length) }, ...(Bun.which("zstd") ? [{ ...row, source_kind: "archive_dir", container: "", member_path: zst }] : [])], []);
    const sources = localSources(rows), result = await dryRun(rows, sources);
    expect(result.import_rows).toBe(2);
    expect(result.sample[0].raw).toBe(bytes.toString());
    expect(sources.errors).toEqual([]);
    expect(await Bun.file(join(dir, "session.jsonl")).exists()).toBe(false);
  } finally { rmSync(dir, { recursive: true }); }
});
