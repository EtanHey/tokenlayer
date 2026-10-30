import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { dryRun, manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { localSources } from "../../src/archaeology/sources";
import { startLocalClickHouse, clickhouseBinary } from "../../src/lib/local-clickhouse";
import { applySchema } from "../../src/lib/schema";
import { exportExisting, readExisting } from "../../src/archaeology/existing";
import { shipOnce } from "../../src/ship/ship";
import { loadState } from "../../src/ship/state";

for (const root of ["codex", "t3-codex"] as const) for (const first of ["archaeology", "shipper"] as const)
test.skipIf(!clickhouseBinary())(`MUST-1 ${root} cold zst: ${first} first has one live owner`, async () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/review-zst-")), sessions = join(dir, root);
  mkdirSync(sessions);
  const path = join(sessions, "rollout-child.jsonl"), packed = path + ".zst";
  const bytes = Buffer.from('{"type":"session_meta","payload":{"id":"child","originator":"T3 Code"}}\n{"type":"turn_context","payload":{"model":"fixture"}}\n');
  writeFileSync(packed, Bun.zstdCompressSync(bytes));
  utimesSync(packed, new Date("2026-01-01"), new Date("2026-01-01"));
  const row: Inventory = { machine: "m4", source_kind: "live", container: "", member_path: packed, session_id: "child", harness: root === "t3-codex" ? "t3" : "codex", bytes: String(bytes.length), lines: "2", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const entries = () => manifest([row, { ...row, source_kind: "archive_dir", member_path: packed }], [], { m4: [sessions] });
  const local = await startLocalClickHouse();
  const opts = { machine: "m4", roots: [{ kind: "codex" as const, dir: sessions }], statePath: join(dir, "state"), clickhouse: local.client, rateBytesPerSec: 0 };
  const backfill = async () => {
    const proc = Bun.spawn([process.execPath, "src/ship/main.ts", "--backfill", "--rate-mb", "0"], { env: {
      PATH: process.env.PATH, HOME: dir, TOKENLAYER_ENV_FILES: join(dir, "absent.env"), TOKENLAYER_MACHINE: "m4",
      TOKENLAYER_CODEX_DIR: sessions, TOKENLAYER_CLAUDE_DIR: join(dir, "absent"), TOKENLAYER_SHIP_STATE: opts.statePath,
      CLICKHOUSE_URL: local.client.config.url, CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "", CLICKHOUSE_DB: "tokenlayer",
    }, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited, error).toBe(0);
  };
  try {
    await applySchema(local.client);
    expect((await shipOnce({ ...opts, sinceMs: Date.now() - 86_400_000 })).lines).toBe(0);
    if (first === "shipper") await backfill();
    const exported = join(dir, "existing.tsv"); await exportExisting(local.client, exported);
    const input = join(dir, "inventory.tsv"), roots = join(dir, "roots.json"), out = join(dir, "out");
    writeFileSync(input, `${Object.keys(row).join("\t")}\n${Object.values(row).join("\t")}\n`);
    writeFileSync(roots, JSON.stringify({ m4: [sessions] }));
    const cli = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", input, "--roots", roots, "--existing", exported, "--out", out], { env: { ...process.env, USER: "fixture" } });
    expect(cli.exitCode, cli.stderr.toString()).toBe(first === "shipper" ? 0 : 2);
    expect(JSON.parse(readFileSync(join(out, "dry-run.json"), "utf8"))).toMatchObject({ import_rows: 0, needs_shipper_backfill: first === "shipper" ? 0 : 2 });
    const copies = entries(), report = await dryRun(copies, { ...localSources(copies), existing: readExisting(exported) });
    expect(report.import_rows).toBe(0);
    expect(report.needs_shipper_backfill).toBe(first === "shipper" ? 0 : 2);
    expect(copies.find(e => e.source_kind === "live")).toBeDefined();
    await local.client.insert("session_events", report.sample);
    if (first === "archaeology") await backfill();
    const state = loadState(opts.statePath);
    expect(state.files[path].generation).toBe(sha256(bytes).slice(0, 16));
    const stored = await local.client.queryJSON<{ path: string; generation: string }>("SELECT path,generation FROM tokenlayer.session_events FINAL");
    expect(stored).toHaveLength(2);
    expect(stored.every(r => r.path === path && r.generation === state.files[path].generation)).toBe(true);
    expect((await local.client.exec("SELECT count() FROM tokenlayer.session_events FINAL WHERE startsWith(path,'archive://')")).trim()).toBe("0");
  } finally { await local.stop(); }
}, 40_000);

test.skipIf(!clickhouseBinary())("NIT-C unresolved owner fails closed with an egress-sanitized path", async () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/unresolved-owner-")), sessions = join(dir, "sessions"); mkdirSync(sessions);
  const secret = "sk-ant-api03-" + "x".repeat(48), path = join(sessions, `unattributed-${secret}.jsonl`), out = join(dir, "existing.tsv");
  writeFileSync(path, '{}\n');
  const local = await startLocalClickHouse();
  try {
    await applySchema(local.client);
    await shipOnce({ machine: "m4", roots: [{ kind: "claude", dir: sessions }], statePath: join(dir, "state"), clickhouse: local.client, rateBytesPerSec: 0 });
    let message = "";
    try { await exportExisting(local.client, out); } catch (error) { message = error instanceof Error ? error.message : ""; }
    expect(message).toContain("invalid --existing export row");
    expect(message).toContain("unattributed-");
    expect(message).toContain("m4");
    expect(message).not.toContain(secret);
    expect(existsSync(out)).toBe(false);
  } finally { await local.stop(); }
}, 40_000);
