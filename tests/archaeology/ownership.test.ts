import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dryRun, manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { clickhouseBinary, startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { applySchema } from "../../src/lib/schema";
import { shipOnce } from "../../src/ship/ship";
import { exportExisting, readExisting } from "../../src/archaeology/existing";

for (const trigger of ["backfill", "mtime"] as const) test.skipIf(!clickhouseBinary())(`SHOULD-A live owner survives archaeology then ${trigger} and backfill`, async () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/ownership-")), path = join(dir, "session.jsonl");
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  writeFileSync(path, bytes); utimesSync(path, new Date("2026-01-01"), new Date("2026-01-01"));
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: path, session_id: "session", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const entries = () => manifest([row, { ...row, member_path: "copy.jsonl", source_kind: "archive_dir" }], [], { m4: [dir] });
  const read = async () => (async function* () { yield bytes; })();
  const local = await startLocalClickHouse();
  try {
    await applySchema(local.client);
    const opts = { machine: "m4", roots: [{ kind: "claude" as const, dir }], statePath: join(dir, "state"), clickhouse: local.client, rateBytesPerSec: 0 };
    const recent = { ...opts, sinceMs: Date.now() - 86_400_000 };
    expect((await shipOnce(recent)).lines).toBe(0);
    const pending = await dryRun(entries(), { existing: [], read });
    expect(pending.import_rows).toBe(0);
    expect(pending).toMatchObject({ needs_shipper_backfill: 1, skip_shipper: 1 });
    expect(pending.sample).toEqual([]);
    const inventory = join(dir, "inventory.tsv"), roots = join(dir, "roots.json"), empty = join(dir, "empty.tsv"), out = join(dir, "out");
    writeFileSync(inventory, `${Object.keys(row).join("\t")}\n${Object.values(row).join("\t")}\n`);
    writeFileSync(roots, JSON.stringify({ m4: [dir] })); await exportExisting(local.client, empty);
    const cli = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", inventory, "--roots", roots, "--existing", empty, "--out", out], { env: { ...process.env, USER: "fixture" } });
    expect(cli.exitCode).toBe(2);
    expect(JSON.parse(readFileSync(join(out, "dry-run.json"), "utf8")).needs_shipper_backfill).toBe(1);
    await local.client.insert("session_events", pending.sample);
    if (trigger === "mtime") utimesSync(path, new Date(), new Date());
    expect((await shipOnce(trigger === "mtime" ? recent : opts)).lines).toBe(1);
    const exported = join(dir, "existing.tsv");
    await exportExisting(local.client, exported);
    const existing = readExisting(exported);
    const covered = await dryRun(entries(), { existing, read });
    expect(covered.import_rows).toBe(0);
    expect(covered).toMatchObject({ needs_shipper_backfill: 0 });
    await local.client.insert("session_events", covered.sample);
    const count = () => local.client.exec("SELECT count() FROM tokenlayer.session_events FINAL");
    const before = await count();
    expect(before.trim()).toBe("1");
    await shipOnce(opts);
    expect(await count()).toBe(before);
    expect((await local.client.exec("SELECT count() FROM tokenlayer.session_events FINAL WHERE startsWith(path,'archive://')")).trim()).toBe("0");
    expect((await dryRun(entries(), { existing: existing.map(([, s, p, h, n]) => ["m1", s, p, h, n]), read })).needs_shipper_backfill).toBe(1);
    expect((await dryRun(entries(), { existing: [["m4", "session", "archive://copy", sha256(bytes), 1]], read })).needs_shipper_backfill).toBe(1);
  } finally { await local.stop(); }
}, 40_000);

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
