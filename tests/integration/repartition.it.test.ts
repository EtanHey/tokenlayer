import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applySchema } from "../../src/lib/schema";
import { repartitionSessionEvents } from "../../src/lib/session-repartition";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

/** The live table before R12: schema/004 with monthly partitions and row-rewriting TTL merges. */
function legacyMonthlyDDL(): string {
  const ddl = readFileSync(new URL("../../schema/004_session_events.sql", import.meta.url), "utf8");
  const legacy = ddl.replace("PARTITION BY toYYYYMMDD(ts)", "PARTITION BY toYYYYMM(ts)").replace(/,\s*ttl_only_drop_parts = 1/, "");
  if (legacy === ddl || /ttl_only_drop_parts/.test(legacy)) throw new Error("fixture no longer derives the monthly table from schema/004");
  return legacy;
}

const row = (path: string, harness: string, ts: string, ingested = "now64(3, 'UTC') - INTERVAL 1 HOUR") =>
  `('m4', '${harness}', '${path}', 'g1', 0, '${path}', ${ts}, ${ingested}, '{"line":"${path}"}')`;
const insert = (ch: LocalClickHouse, table: string, values: string[]) => ch.client.exec(
  `INSERT INTO tokenlayer.${table} (machine, harness, path, generation, byte_offset, content_hash, ts, ingested_at, raw) VALUES ${values.join(",")}`);

describe.skipIf(!clickhouseBinary())("monthly → daily repartition → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  const tables = async () => (await ch.client.queryJSON<{ name: string; partition_key: string }>(
    "SELECT name, partition_key FROM system.tables WHERE database = 'tokenlayer' AND startsWith(name, 'session_events') ORDER BY name"));
  const finalRows = async () => (await ch.client.queryJSON<{ path: string; harness: string }>(
    "SELECT path, harness FROM tokenlayer.session_events FINAL ORDER BY path"));
  const expected = [
    { path: "agy-old", harness: "antigravity" },
    { path: "jan-1970", harness: "claude" },
    { path: "recent-a", harness: "t3" }, // the later version of a duplicated key wins
    { path: "recent-b", harness: "codex" },
    { path: "undated", harness: "t3" },
  ];

  beforeEach(async () => {
    ch = await startLocalClickHouse();
    await ch.client.exec("CREATE DATABASE tokenlayer");
    await ch.client.exec(legacyMonthlyDDL());
    await applySchema(ch.client);
    await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events"); // keep both versions of recent-a on disk
    await insert(ch, "session_events", [
      row("recent-a", "claude", "now64(3, 'UTC') - INTERVAL 2 DAY", "now64(3, 'UTC') - INTERVAL 2 HOUR"),
      row("recent-b", "codex", "now64(3, 'UTC') - INTERVAL 25 DAY"),
      row("expired", "claude", "now64(3, 'UTC') - INTERVAL 45 DAY"),
      row("agy-old", "antigravity", "now64(3, 'UTC') - INTERVAL 45 DAY"),
      row("undated", "t3", "toDateTime64(0, 3, 'UTC')"),
      row("jan-1970", "claude", "toDateTime64(86400 * 3, 3, 'UTC')"),
    ]);
    await insert(ch, "session_events", [row("recent-a", "t3", "now64(3, 'UTC') - INTERVAL 2 DAY")]);
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.session_events")).trim()).toBe("7");
  }, 40_000);
  afterEach(async () => { await ch?.stop(); });

  test("copies kept rows deduplicated into daily partitions, drops the archive, keeps the views working", async () => {
    const report = await repartitionSessionEvents(ch.client, { floorBytes: 0 });
    expect(report.state).toBe("done");
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMMDD(ts)" }]);
    const [t] = await ch.client.queryJSON<{ create_table_query: string }>(
      "SELECT create_table_query FROM system.tables WHERE database = 'tokenlayer' AND name = 'session_events'");
    expect(t.create_table_query).toContain("ttl_only_drop_parts = 1");
    expect(t.create_table_query).toContain("merge_with_ttl_timeout = 3600");
    expect(t.create_table_query).toMatch(/TTL toDateTime\(ts\) \+ toIntervalDay\(30\) WHERE \(harness != 'antigravity'\) AND \(toYYYYMM\(ts\) != 197001\)/);
    expect(await finalRows()).toEqual(expected);
    // Already deduplicated on the way in: one row per key without FINAL.
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.session_events")).trim()).toBe("5");
    // MATERIALIZED columns are recomputed from raw by the insert.
    expect((await ch.client.exec("SELECT sum(raw_has_message) + countIf(raw = '') FROM tokenlayer.session_events")).trim()).toBe("0");
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.v_session_events_meta")).trim()).toBe("5");
    // schema:apply afterwards is a no-op and leaves the daily table as is.
    await applySchema(ch.client);
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMMDD(ts)" }]);
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0 })).state).toBe("already-daily");
  }, 60_000);

  test("a window cut short resumes, and rows shipped meanwhile win over the archive's older versions", async () => {
    const first = await repartitionSessionEvents(ch.client, { floorBytes: 0, maxPartitions: 1 });
    expect(first.state).toBe("partial");
    expect(first.copied).toHaveLength(1);
    expect((await tables()).map(t => t.name)).toEqual(["session_events", "session_events_monthly"]);
    // The shipper keeps writing to the live (daily) table during the window.
    await insert(ch, "session_events", [row("recent-b", "codex", "now64(3, 'UTC') - INTERVAL 25 DAY", "now64(3, 'UTC')")]);
    await insert(ch, "session_events", [row("recent-a", "t3", "now64(3, 'UTC') - INTERVAL 2 DAY", "now64(3, 'UTC')")]);
    const done = await repartitionSessionEvents(ch.client, { floorBytes: 0 });
    expect(done.state).toBe("done");
    expect(await finalRows()).toEqual(expected);
    expect((await tables()).map(t => t.name)).toEqual(["session_events"]);
  }, 60_000);

  test("the disk floor refuses before the exchange and changes nothing", async () => {
    await expect(repartitionSessionEvents(ch.client, { floorBytes: 2 ** 60 })).rejects.toThrow(/floor/);
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMM(ts)" }]);
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.session_events")).trim()).toBe("7");
  }, 40_000);

  test("dry run reports the plan and changes nothing", async () => {
    const plan = await repartitionSessionEvents(ch.client, { floorBytes: 0, dryRun: true });
    expect(plan.state).toBe("dry-run");
    expect(plan.remaining.map(p => p.partition).sort()).toEqual(expect.arrayContaining(["197001"]));
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMM(ts)" }]);
  }, 40_000);
});
