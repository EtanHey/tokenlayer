import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dryRun, manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";

test("SHOULD-A a custom order cannot import archive bytes before their live owner", async () => {
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: "/live/session.jsonl", session_id: "session", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const entries = manifest([row, { ...row, source_kind: "archive_dir", member_path: "copy.jsonl" }], [], { m4: ["/live"] });
  await expect(dryRun(entries, { read: async () => (async function* () { yield bytes; })(), order: (async function* () { yield entries[1]; yield entries[0]; })() })).rejects.toThrow("live sources must precede archives");
});

test("SHOULD-A a prior session at the same live path is not backfill coverage", async () => {
  const path = "/live/session.jsonl", header = Buffer.from('{"sessionId":"session-b","type":"user"}\n'), marker = Buffer.from('{"type":"mode"}\n'), bytes = Buffer.concat([header, marker]);
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: path, session_id: "session-b", harness: "claude", bytes: String(bytes.length), lines: "2", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const report = await dryRun(manifest([row], [], { m4: ["/live"] }), {
    existing: [["m4", "session-b", path, sha256(header), 1], ["m4", "session-a", path, sha256(marker), 1]],
    read: async () => (async function* () { yield bytes; })(),
  });
  expect(report.needs_shipper_backfill).toBe(1);
  expect(report.import_rows).toBe(0);
});

for (const failure of ["source_changed", "read_error", "needs_fetch", "second_read_error"] as const) test(`SHOULD-1 ${failure} live owner reserves every archive copy`, async () => {
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: "/live/session.jsonl", session_id: "session", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const entries = manifest([row, { ...row, source_kind: "archive_dir", member_path: "copy.jsonl" }], [], { m4: ["/live"] });
  let liveReads = 0;
  const report = await dryRun(entries, { read: async e => {
    if (e.source_kind !== "live") return (async function* () { yield bytes; })();
    liveReads++;
    if (failure === "read_error" || failure === "second_read_error" && liveReads === 2) throw Error("fixture read failed");
    if (failure === "needs_fetch") return null;
    return (async function* () { yield failure === "source_changed" ? Buffer.concat([bytes, bytes]) : bytes; })();
  } });
  expect(report.import_rows).toBe(0); expect(report.sample).toEqual([]);
  expect(report.skip_shipper).toBe(1);
  expect(report).toMatchObject({ blocked_live: 1 });
});

test("SHOULD-1 appended-after-inventory CLI is blocked with zero archive imports", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/changed-live-")), path = join(dir, "session.jsonl"), copy = join(dir, "copy.jsonl");
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: path, session_id: "session", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const inventory = join(dir, "inventory.tsv"), roots = join(dir, "roots.json"), existing = join(dir, "existing.tsv"), out = join(dir, "out");
  writeFileSync(inventory, `${Object.keys(row).join("\t")}\n` + [row, { ...row, source_kind: "archive_dir", member_path: copy }].map(r => Object.values(r).join("\t")).join("\n") + "\n");
  writeFileSync(path, Buffer.concat([bytes, bytes])); writeFileSync(copy, bytes);
  writeFileSync(roots, JSON.stringify({ m4: [dir] })); writeFileSync(existing, "machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount\n");
  const cli = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", inventory, "--roots", roots, "--existing", existing, "--out", out], { env: { ...process.env, USER: "fixture" } });
  expect(cli.exitCode).toBe(2);
  expect(JSON.parse(readFileSync(join(out, "dry-run.json"), "utf8"))).toMatchObject({ source_changed: 1, blocked_live: 1, import_rows: 0, skip_shipper: 1 });
});

test("MUST-1 plain sibling remains the shipper owner when both encodings exist", async () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/plain-owner-")), path = join(dir, "rollout-child.jsonl");
  const bytes = Buffer.from('{"type":"session_meta","payload":{"id":"child"}}\n');
  writeFileSync(path, bytes); writeFileSync(path + ".zst", Bun.zstdCompressSync(bytes));
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: path, session_id: "child", harness: "codex", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const entries = manifest([row, { ...row, member_path: path + ".zst" }], [], { m4: [dir] });
  const report = await dryRun(entries, { read: async () => (async function* () { yield bytes; })() });
  expect(report.import_rows).toBe(0);
  expect(report.needs_shipper_backfill).toBe(1);
  expect(report.skip_shipper).toBe(1);
  expect(entries.filter(e => e.source_kind === "live").map(e => e.member_path)).toEqual([path]);
});
