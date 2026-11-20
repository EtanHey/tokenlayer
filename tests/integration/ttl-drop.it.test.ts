import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

// R12: a row TTL on monthly partitions rewrites a whole part every merge_with_ttl_timeout to remove one hour of rows,
// and never touches a part over the 1 GiB merge cap (live: 288k rows of 18 Oct stayed 56 h past expiry in a 1.59 GiB
// part). Daily partitions with ttl_only_drop_parts drop a day once every row in it has expired, and rewrite nothing.
describe.skipIf(!clickhouseBinary())("TTL drops whole days, never rewrites a partly expired part → real local ClickHouse", () => {
  let local: LocalClickHouse;
  beforeAll(async () => { local = await startLocalClickHouse({ prepare: applySchema }); }, 40_000);
  afterAll(async () => { await local?.stop(); });

  const rows = (where: string) => local.client.queryJSON<{ path: string }>(
    `SELECT path FROM tokenlayer.session_events WHERE ${where} ORDER BY path`).then(r => r.map(x => x.path));

  test("a fully expired day goes with its exempt rows kept; a partly expired day's part is untouched", async () => {
    // Day D = the UTC day 30 days ago: its first row has expired, its last row has not (it expires at D+30 23:59:59).
    await local.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, ts) VALUES
      ('fixture', 'claude', 'partly-early', toDateTime64(toDate(now('UTC') - INTERVAL 30 DAY), 3, 'UTC')),
      ('fixture', 'claude', 'partly-late', toDateTime64(toDate(now('UTC') - INTERVAL 30 DAY), 3, 'UTC') + INTERVAL 86399 SECOND)`);
    // A day that expired a week ago, with an Antigravity row inside it, plus undated and recent rows.
    await local.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, ts) VALUES
      ('fixture', 'claude', 'gone', toDateTime64(toDate(now('UTC') - INTERVAL 40 DAY), 3, 'UTC') + INTERVAL 3600 SECOND),
      ('fixture', 'antigravity', 'agy', toDateTime64(toDate(now('UTC') - INTERVAL 40 DAY), 3, 'UTC') + INTERVAL 7200 SECOND),
      ('fixture', 't3', 'undated', toDateTime64(0, 3, 'UTC')),
      ('fixture', 'codex', 'recent', now64(3, 'UTC') - INTERVAL 1 DAY)`);
    const partlyPart = () => local.client.queryJSON<{ part: string }>(
      "SELECT DISTINCT _part AS part FROM tokenlayer.session_events WHERE path LIKE 'partly-%'");
    const partly = await partlyPart();
    expect(partly).toHaveLength(1);

    // Background TTL only: no OPTIMIZE. The expired day's drop is the proof the scheduler ran.
    const deadline = Date.now() + 30_000;
    while ((await rows("path = 'gone'")).length && Date.now() < deadline) await Bun.sleep(250);
    expect(await rows("path = 'gone'")).toEqual([]);
    await Bun.sleep(2_000);

    expect(await rows("1")).toEqual(["agy", "partly-early", "partly-late", "recent", "undated"]);
    expect(await partlyPart()).toEqual(partly);
  }, 40_000);

  test("fresh tables are daily-partitioned and drop only whole parts", async () => {
    const [t] = await local.client.queryJSON<{ partition_key: string; create_table_query: string }>(
      "SELECT partition_key, create_table_query FROM system.tables WHERE database='tokenlayer' AND name='session_events'");
    expect(t.partition_key).toBe("toYYYYMMDD(ts)");
    expect(t.create_table_query).toContain("ttl_only_drop_parts = 1");
  });

  test("one insert may span more than 100 days (Antigravity rows are kept for ever)", async () => {
    const batch = Array.from({ length: 120 }, (_, i) => ({
      machine: "fixture", harness: "antigravity", path: "agy-span", generation: "g", byte_offset: i, content_hash: String(i),
      ts: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().replace("T", " ").replace("Z", ""),
    }));
    await local.client.insert("session_events", batch);
    expect((await local.client.exec("SELECT count() FROM tokenlayer.session_events WHERE path = 'agy-span'")).trim()).toBe("120");
  });
});
