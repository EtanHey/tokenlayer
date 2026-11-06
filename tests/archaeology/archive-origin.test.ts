import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { origin, manifest, repoMap, dryRun, type Inventory } from "../../src/archaeology/pipeline";
import { inventory } from "../../src/archaeology/main";
import { observeGit } from "../../src/archaeology/repo-evidence";
import { localSources } from "../../src/archaeology/sources";

// All paths and metadata below are synthetic. machine is the observed collector,
// not historical host evidence. There is no archive-origin attestation contract.
const row = (overrides: Partial<Inventory> = {}): Inventory => ({
  machine: "m4", source_kind: "moved_archive", container: "",
  member_path: "/Users/etanheyman/.claude-archive/domica/archive-old/session.jsonl",
  session_id: "session", harness: "claude", bytes: "40", lines: "1",
  first_ts: "2025-12-24T10:18:34Z", last_ts: "2026-01-04T00:00:00Z",
  cwd: "", sha256: "a".repeat(64), mtime: "2026-02-01", ...overrides,
});

for (const [name, source] of [
  ["moved archive in M4 custody", row()],
  ["copied happycampr path in M4 custody", row({ member_path: "/Users/happycampr/.claude/projects/p/session.jsonl" })],
  ["misleading cwd", row({ cwd: "/Users/happycampr/Gits/p" })],
  ["folder username", row({ member_path: "-Users-etanheyman-Gits-p/session.jsonl" })],
  ["inventory machine fallback", row({ member_path: "session.jsonl" })],
  ["tar member", row({ source_kind: "tarball_member", container: "/archives/backup.tar" })],
  ["Drive member", row({ source_kind: "drive_tarball_member", machine: "drive", cwd: "/Users/etanheyman/Gits/p" })],
  ["unverified source", row({ source_kind: "unverified", cwd: "/Users/happycampr/Gits/p" })],
] as const) test(`archive origin stays UNKNOWN: ${name}`, async () => {
  expect(origin(source)).toBe("unknown");
  const entries = manifest([source], []);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ ...source, origin: "unknown" });
  let reads = 0;
  const report = await dryRun(entries, { read: async () => { reads++; throw Error("forbidden source read"); } });
  expect(reads).toBe(0);
  expect(report).toMatchObject({ import_rows: 0, import_bytes: 0, needs_fetch: 1, sample: [], groups: {} });
  expect(entries[0].status).toBe("needs_fetch_or_export");
});

test("conflicting explicit archive declarations cannot override UNKNOWN", async () => {
  const source = row({ cwd: "/Users/happycampr/Gits/p" });
  const entries = manifest([source], []);
  // Model a retained pre-correction entry. dryRun must not trust its old label.
  entries[0].origin = "m1";
  let reads = 0;
  const report = await dryRun(entries, { read: async () => { reads++; return null; } });
  expect(entries[0].origin).toBe("unknown");
  expect(report.import_rows).toBe(0); expect(reads).toBe(0);
});

test("TSV replay keeps custody metadata and ignores self-declared origin proof", () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-origin-tsv-")), path = join(dir, "inventory.tsv");
  const source = { ...row(), origin: "m1", originMachine: "m4", originProof: "trusted", originalGeneration: "invented" };
  writeFileSync(path, Object.keys(source).join("\t") + "\n" + Object.values(source).join("\t") + "\n");
  const rows = inventory(path);
  expect(rows).toEqual([row()]);
  expect(manifest(rows, [])[0]).toMatchObject({ machine: "m4", origin: "unknown" });
});

test("machine-specific repo evidence does not certify an archive host", () => {
  const source = row({ cwd: "/Users/etanheyman/Gits/p" });
  const maps = repoMap([source], [{ machine: "m4", cwd: source.cwd, repo: "Owner/p", evidence: "current remote", confidence: "high" }]);
  expect(maps.every(m => m.machine === "unknown" && !m.repo_canonical)).toBe(true);
  expect(manifest([source], maps)[0].repo).toBe("");
});

test("current repo observations retain declared collector despite cwd username", () => {
  const observation = observeGit({ machine: "m4", cwd: "/Users/happycampr/Gits/nonexistent-origin-fixture", git_remote: "Owner/p" }, "m1");
  expect(observation).toMatchObject({ machine: "m4", current: false, remote: "Owner/p", toplevel: "" });
});

test("live collection is current custody; off-root reclassification loses origin", async () => {
  const source = row({ source_kind: "live", cwd: "/Users/happycampr/Gits/p", member_path: "/current/session.jsonl" });
  const entries = manifest([source], [], { m4: ["/current"] });
  expect(entries[0]).toMatchObject({ source_kind: "live", machine: "m4", origin: "m4" });
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  entries[0].bytes = String(bytes.length); entries[0].sha256 = "";
  const report = await dryRun(entries, { read: async () => (async function* () { yield bytes; })() });
  expect(report).toMatchObject({ live_rows: 1, needs_shipper_backfill: 1, import_rows: 0, sample: [] });
  const offRoot = manifest([source], [], { m4: ["/elsewhere"] });
  expect(offRoot[0]).toMatchObject({ source_kind: "archive_dir", origin: "unknown" });
});

test("unknown archives stay inventoried without pre-read container hashing or decoding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-origin-sources-"));
  const packed = join(dir, "session.jsonl.zst"), tar = join(dir, "archive.tar");
  writeFileSync(packed, "synthetic undecodable body"); writeFileSync(tar, "synthetic invalid tar");
  const entries = manifest([row({ source_kind: "archive_dir", member_path: packed }), row({ source_kind: "tarball_member", container: tar, member_path: "session.jsonl" })], []);
  const probed: string[] = [];
  const sources = localSources(entries, paths => { probed.push(...paths); return new Set(); });
  const report = await dryRun(entries, sources);
  expect(probed).toEqual([]);
  expect(entries).toHaveLength(2);
  expect(entries.every(e => e.origin === "unknown" && e.container_hash === "")).toBe(true);
  expect(report).toMatchObject({ needs_fetch: 2, import_rows: 0, read_errors: 0, sample: [] });
  expect(sources.errors).toEqual([]);
  expect(readFileSync(packed, "utf8")).toBe("synthetic undecodable body");
});

test("held tar metadata retains its invalid-member-hash diagnostic without a read", async () => {
  const entries = manifest([row({ source_kind: "tarball_member", container: "/nonexistent-origin-fixture.tar", sha256: "md5:unknown" })], []);
  const sources = localSources(entries, () => { throw Error("forbidden probe"); });
  const report = await dryRun(entries, sources);
  expect(entries[0]).toMatchObject({ origin: "unknown", status: "invalid_member_hash", container_hash: "" });
  expect(report).toMatchObject({ import_rows: 0, invalid_member_hash: 1, sample: [] });
  expect(sources.errors[0].reason).toContain("expected member hash must be SHA-256 hex");
});

test("CLI persists UNKNOWN origin and observed custody on replay without raw output", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archive-origin-cli-")));
  const source = row(), input = join(dir, "inventory.tsv"), existing = join(dir, "existing.tsv"), out = join(dir, "out");
  writeFileSync(input, Object.keys(source).join("\t") + "\n" + Object.values(source).join("\t") + "\n");
  writeFileSync(existing, "machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount\n");
  const proc = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", input, "--existing", existing, "--out", out], { env: { ...process.env, USER: "fixture" } });
  expect(proc.exitCode, proc.stderr.toString()).toBe(0); // A report, not source acceptance or an apply mode.
  const manifestPath = join(out, "manifest.tsv");
  expect(inventory(manifestPath)).toEqual([source]);
  const [header, data] = readFileSync(manifestPath, "utf8").trimEnd().split("\n").map(s => s.split("\t"));
  expect(data[header.indexOf("origin")]).toBe("unknown");
  expect(data[header.indexOf("status")]).toBe("needs_fetch_or_export");
  expect(JSON.parse(readFileSync(join(out, "dry-run.json"), "utf8"))).toMatchObject({ import_rows: 0, needs_fetch: 1, groups: {} });
});
