import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, origin, repoMap, manifest, dryRun, sha256, type Inventory } from "../../src/archaeology/pipeline";

const row = (overrides: Partial<Inventory> = {}): Inventory => ({ machine: "M4", source_kind: "archive_dir", container: "", member_path: "/Users/etanheyman/.claude-archive/projects/old/s.jsonl", session_id: "session", harness: "claude", bytes: "1", lines: "1", first_ts: "2026-01-01T00:00:00Z", last_ts: "2026-01-01T00:00:00Z", cwd: "/Users/etanheyman/Desktop/Gits/old/.worktrees/lane", sha256: "", mtime: "", ...overrides });
test("canonical longest copy, prefix skips, renamed repo and unchanged sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archaeology-"));
  try {
    const a = Buffer.from('{ "sessionId":"session", "timestamp":"2026-01-01T00:00:00Z", "type":"user" }\n');
    const b = Buffer.concat([a, Buffer.from('{"sessionId":"session","type":"assistant"}\n')]);
    const paths = [join(dir, "full.jsonl"), join(dir, "prefix.jsonl")];
    paths.forEach((p, i) => writeFileSync(p, i ? a : b));
    const before = paths.map(p => [statSync(p).size, statSync(p).mtimeMs]);
    const copies = paths.map((p, i) => row({ member_path: p, bytes: String(i ? a.length : b.length), sha256: sha256(i ? a : b) }));
    const maps = repoMap(copies, [{ cwd: copies[0].cwd, repo: "EtanHey/new", evidence: "GitHub rename redirect old → new", confidence: "high" }]);
    const entries = manifest(copies, maps);
    const result = await dryRun(entries, { read: async r => (async function* () { yield Buffer.from(await Bun.file(r.member_path).arrayBuffer()); })() });
    expect(result.import_rows).toBe(2);
    expect(result.skip_copy).toBe(1);
    expect(result.import_sessions).toBe(1);
    expect(entries.filter(r => r.selected)).toHaveLength(1);
    expect(entries[1].relation).toBe("prefix");
    expect(result.sample[0].project).toBe("EtanHey/new");
    expect(result.sample[0].raw).toBe(a.toString());
    expect(result.sample[0].content_hash).toBe(sha256(a));
    expect(result.sample[0].generation).toBe(`archive:${sha256(b)}`);
    expect(paths.map(p => [statSync(p).size, statSync(p).mtimeMs])).toEqual(before);
  } finally { rmSync(dir, { recursive: true }); }
});
test("exclude synthetic corpora and telemetry; retain subagents, zst and metadata-only T3", () => {
  for (const p of ["/repo/tests/fixtures/s.jsonl", "/eval-gates/runs/corpus-snapshots/s.jsonl", "/benchmarks/s.jsonl", "/synthetic/home/.claude/projects/s.jsonl", "/registry/events.jsonl"]) expect(classify(row({ member_path: p })).session).toBe(false);
  expect(classify(row({ member_path: "/.claude/projects/x/subagents/agent-a.jsonl" })).session).toBe(true);
  expect(classify(row({ harness: "codex", member_path: "/.codex/sessions/rollout-x.jsonl.zst" })).session).toBe(true);
  expect(classify(row({ source_kind: "t3_sqlite", harness: "t3" })).session).toBe(true);
  expect(classify(row({ member_path: "placeholder.tgz", bytes: "40" })).session).toBe(false);
  expect(origin(row({ machine: "drive", cwd: "/Users/happycampr/Gits/x" }))).toBe("m1");
  expect(origin(row({ machine: "drive", cwd: "", member_path: "source-0/s.jsonl" }))).toBe("unknown");
});
test("divergent copies retain unique lines; live pairs skip; unfetched and changed files stay explicit", async () => {
  const a = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const b = Buffer.from('{"sessionId":"session","type":"assistant"}\n');
  const copies = [row({ source_kind: "live", member_path: "live.jsonl", sha256: sha256(a), bytes: String(a.length) }), row({ member_path: "archive.jsonl", sha256: sha256(b), bytes: String(b.length) }), row({ member_path: "duplicate.jsonl", sha256: sha256(a), bytes: String(a.length) }), row({ member_path: "remote.jsonl", session_id: "remote", source_kind: "drive_file" })];
  const entries = manifest(copies, []);
  const result = await dryRun(entries, { read: async r => r.member_path === "remote.jsonl" ? null : (async function* () { yield r.member_path === "archive.jsonl" ? b : a; })() });
  expect(result.import_rows).toBe(1);
  expect(result.skip_live).toBe(1);
  expect(result.divergent_sessions).toBe(1);
  expect(result.needs_fetch).toBe(1);
  const changed = await dryRun(manifest([row({ sha256: sha256(a), bytes: String(a.length) })], []), { read: async () => (async function* () { yield b; })() });
  expect(changed.import_rows).toBe(0);
  expect(changed.source_changed).toBe(1);
});
test("existing shipper pair export prevents cross-path inserts; invalid UTF-8 fails closed", async () => {
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\r\n');
  const rows = manifest([row({ bytes: String(bytes.length), sha256: sha256(bytes) })], []);
  const report = await dryRun(rows, { existing: [["session", sha256(bytes)]], read: async () => (async function* () { yield bytes.subarray(0, 7); yield bytes.subarray(7); })() });
  expect(report.import_rows).toBe(0); expect(report.skip_live).toBe(1);
  const invalid = Buffer.from([0xff, 10]);
  const rejected = await dryRun(manifest([row({ bytes: "2", sha256: sha256(invalid) })], []), { read: async () => (async function* () { yield invalid; })() });
  expect(rejected.read_errors).toBe(1); expect(rejected.import_rows).toBe(0);
});
