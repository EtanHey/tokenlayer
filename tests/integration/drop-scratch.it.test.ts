import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

const tables = ["credentials_snap", "r7_session_events_narrow", "r7_session_events_day"];
const root = join(import.meta.dir, "../..");

describe.skipIf(!clickhouseBinary())("guarded scratch drop → real local ClickHouse", () => {
  let local: LocalClickHouse;
  beforeAll(async () => {
    local = await startLocalClickHouse();
    await local.client.exec("CREATE DATABASE tokenlayer");
  }, 40_000);
  afterAll(async () => { await local?.stop(); });
  beforeEach(async () => {
    for (const table of tables) {
      await local.client.exec(`DROP TABLE IF EXISTS tokenlayer.${table} SYNC`);
      await local.client.exec(`CREATE TABLE tokenlayer.${table} (n UInt8) ENGINE = Memory`);
    }
    for (const table of tables.slice(1)) await local.client.exec(`INSERT INTO tokenlayer.${table} VALUES (1), (2)`);
  });

  const env = () => ({ ...process.env, CLICKHOUSE_URL: local.client.config.url,
    CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "", CLICKHOUSE_DB: "tokenlayer" });
  const run = async (args: string[] = [], script = "src/lib/drop-scratch.ts") => {
    const proc = Bun.spawn([process.execPath, script, ...args], { cwd: root, env: env(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const remaining = () => local.client.queryJSON<{ name: string }>(
    "SELECT name FROM system.tables WHERE database = 'tokenlayer' AND name IN ('credentials_snap', 'r7_session_events_narrow', 'r7_session_events_day') ORDER BY name");

  test("default dry run prints metadata and counts without dropping anything", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("BEFORE");
    expect(result.stdout).toContain('"engine":"Memory"');
    expect(result.stdout).toContain('"total_rows":');
    expect(result.stdout).toContain("credentials_snap rows=0");
    expect(result.stdout).toContain("r7_session_events_narrow rows=2");
    expect(result.stdout).toContain("r7_session_events_day rows=2");
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("AFTER");
    expect(await remaining()).toHaveLength(3);
  });

  test("empty credentials permits all drops; a second run and schema:apply do not restore them", async () => {
    const first = await run(["--apply"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("BEFORE");
    expect(first.stdout).toContain("AFTER");
    expect(await remaining()).toEqual([]);
    const second = await run(["--apply"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("credentials_snap absent");
    expect(await remaining()).toEqual([]);
    const schema = await run([], "src/lib/schema.ts");
    expect(schema.code).toBe(0);
    expect(await remaining()).toEqual([]);
  }, 40_000);

  test("one credentials row refuses both modes with its count and preserves every table", async () => {
    await local.client.exec("INSERT INTO tokenlayer.credentials_snap VALUES (1)");
    for (const args of [[], ["--apply"]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("credentials_snap rows=1");
      expect(result.stdout + result.stderr).toContain("STOP");
      expect(result.stdout).toContain("AFTER");
      expect(await remaining()).toHaveLength(3);
      for (const table of tables) expect((await local.client.exec(`SELECT count() FROM tokenlayer.${table}`)).trim())
        .toBe(table === "credentials_snap" ? "1" : "2");
    }
  });

  test("dependent views in this or another database refuse both modes without dropping anything", async () => {
    await local.client.exec("CREATE DATABASE scratch_dependency");
    await local.client.exec("CREATE VIEW tokenlayer.v_dep AS SELECT * FROM tokenlayer.credentials_snap");
    await local.client.exec("CREATE VIEW scratch_dependency.v_dep AS SELECT * FROM tokenlayer.r7_session_events_day");
    try {
      for (const args of [[], ["--apply"]]) {
        const result = await run(args);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toContain("DEPENDENT tokenlayer.v_dep reads credentials_snap");
        expect(result.stdout).toContain("DEPENDENT scratch_dependency.v_dep reads r7_session_events_day");
        expect(result.stdout + result.stderr).toContain("STOP");
        expect(await remaining()).toHaveLength(3);
      }
    } finally {
      await local.client.exec("DROP VIEW tokenlayer.v_dep SYNC");
      await local.client.exec("DROP DATABASE scratch_dependency SYNC");
    }
  });

  test("absent credentials is a no-op while existing scratch tables are removed", async () => {
    await local.client.exec("DROP TABLE tokenlayer.credentials_snap SYNC");
    const result = await run(["--apply"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("credentials_snap absent");
    expect(await remaining()).toEqual([]);
  });
});
