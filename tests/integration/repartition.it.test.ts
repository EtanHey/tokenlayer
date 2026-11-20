import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applySchema } from "../../src/lib/schema";
import * as repartition from "../../src/lib/session-repartition";
import type { ClickHouse } from "../../src/lib/clickhouse";
/** Every run here takes both Macs' shippers as ready unless a test says otherwise (the real probe reads launchd and ssh). */
const repartitionSessionEvents = (c: ClickHouse, o: repartition.RepartitionOptions = {}) =>
  repartition.repartitionSessionEvents(c, { shipperCheck: async () => [], ...o });
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

/** `n` recent claude rows in one insert, so one part: big enough for a copy to be watched while it runs. */
const bulk = (ch: LocalClickHouse, n: number) => ch.client.exec(
  `INSERT INTO tokenlayer.session_events (machine, harness, path, generation, byte_offset, content_hash, ts, ingested_at, raw)
   SELECT 'm4', 'claude', concat('bulk-', toString(intDiv(number, 500))), 'g1', number, toString(number),
     now64(3, 'UTC') - INTERVAL 3 DAY + toIntervalSecond(number % 600), now64(3, 'UTC') - INTERVAL 1 HOUR, repeat('x', 200)
   FROM numbers(${n})`);
/** Slows the copy's read to a few thousand rows a second, so a test can act while the INSERT runs on the server. */
const SLOW_COPY = { max_threads: 1, max_block_size: 100, max_execution_speed: 4000, timeout_before_checking_execution_speed: 0 };
const runningCopies = async (ch: LocalClickHouse) =>
  Number((await ch.client.exec("SELECT count() FROM system.processes WHERE startsWith(query_id, 'r12-')")).trim());
async function untilCopyRuns(ch: LocalClickHouse, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await runningCopies(ch)) return true;
  return false;
}

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

  test("copies kept rows part by part into daily partitions, drops the archive, keeps the views working", async () => {
    const report = await repartitionSessionEvents(ch.client, { floorBytes: 0 });
    expect(report.state).toBe("done");
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMMDD(ts)" }]);
    const [t] = await ch.client.queryJSON<{ create_table_query: string }>(
      "SELECT create_table_query FROM system.tables WHERE database = 'tokenlayer' AND name = 'session_events'");
    expect(t.create_table_query).toContain("ttl_only_drop_parts = 1");
    expect(t.create_table_query).toContain("merge_with_ttl_timeout = 3600");
    expect(t.create_table_query).toMatch(/TTL toDateTime\(ts\) \+ toIntervalDay\(30\) WHERE \(harness != 'antigravity'\) AND \(toYYYYMM\(ts\) != 197001\)/);
    expect(await finalRows()).toEqual(expected);
    // Both versions of recent-a are copied as they are; the day's merge collapses them like any replay.
    await ch.client.exec("OPTIMIZE TABLE tokenlayer.session_events FINAL");
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
    const first = await repartitionSessionEvents(ch.client, { floorBytes: 0, maxParts: 1 });
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
  test("M1: copies one day of a part per INSERT, each with its own query_id", async () => {
    await ch.stop();
    ch = await startLocalClickHouse({ queryLog: true });
    await ch.client.exec("CREATE DATABASE tokenlayer");
    await ch.client.exec(legacyMonthlyDDL());
    await applySchema(ch.client);
    await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events");
    // One part whose kept rows fall on three days.
    await insert(ch, "session_events", [
      row("d1", "claude", "now64(3, 'UTC') - INTERVAL 3 DAY"),
      row("d2", "codex", "now64(3, 'UTC') - INTERVAL 4 DAY"),
      row("d3", "t3", "now64(3, 'UTC') - INTERVAL 5 DAY"),
    ]);
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0 })).state).toBe("done");
    await ch.client.exec("SYSTEM FLUSH LOGS");
    const copies = await ch.client.queryJSON<{ query_id: string; query: string }>(
      "SELECT query_id, query FROM system.query_log WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND startsWith(query_id, 'r12-')");
    expect(copies).toHaveLength(3);
    for (const c of copies) expect(c.query).toMatch(/toYYYYMMDD\(ts\) = \d{8}/);
    expect(new Set(copies.map(c => c.query_id)).size).toBe(3);
  }, 60_000);

  test("M1: a watchdog kills the server-side copy when free disk falls under the floor; the archive part stays", async () => {
    await bulk(ch, 20_000);
    const lowWhileCopying = async () => (await runningCopies(ch)) ? 0 : 2 ** 50;
    const report = await repartitionSessionEvents(ch.client, {
      floorBytes: 2 ** 40, freeBytes: lowWhileCopying, extraCopySettings: SLOW_COPY, watchMs: 100,
    });
    expect(report.state).toBe("partial");
    expect(report.stopped).toMatch(/floor/);
    expect(await runningCopies(ch)).toBe(0);
    const bulkPart = await ch.client.exec(
      "SELECT count() FROM tokenlayer.session_events_monthly WHERE startsWith(path, 'bulk-')");
    expect(bulkPart.trim()).toBe("20000");
  }, 60_000);

  test("S1: the pre-exchange refusal tests the largest part with the disk multiplier", async () => {
    await bulk(ch, 20_000);
    const [largest] = await ch.client.queryJSON<{ name: string; b: string }>(
      "SELECT name, toString(bytes_on_disk) b FROM system.parts WHERE database = 'tokenlayer' AND table = 'session_events' AND active ORDER BY bytes_on_disk DESC LIMIT 1");
    const floorBytes = 2 ** 40;
    // Room for the largest part once, not for what its copy really takes.
    const free = async () => floorBytes + Number(largest.b);
    await expect(repartitionSessionEvents(ch.client, { floorBytes, freeBytes: free })).rejects.toThrow(new RegExp(`${largest.name}.*nothing changed`));
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMM(ts)" }]);
  }, 60_000);

  test("S2: refuses to start while a copy from an earlier run still runs on the server", async () => {
    const { url } = ch.client.config;
    const orphan = fetch(`${url}/?query_id=r12-orphan-test`, { method: "POST", body: "SELECT count() FROM numbers(1000000000000) SETTINGS max_threads = 1" })
      .then(r => r.text()).catch(() => "");
    try {
      expect(await untilCopyRuns(ch)).toBe(true);
      await expect(repartitionSessionEvents(ch.client, { floorBytes: 0 })).rejects.toThrow(/still running.*r12-orphan-test/);
      expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMM(ts)" }]);
    } finally {
      await ch.client.exec("KILL QUERY WHERE query_id = 'r12-orphan-test' SYNC");
      await orphan;
    }
  }, 60_000);

  test("S2: an abort (Ctrl-C) kills the server-side copy before returning; the archive part stays", async () => {
    await bulk(ch, 20_000);
    const abort = new AbortController();
    const run = repartitionSessionEvents(ch.client, { floorBytes: 0, extraCopySettings: SLOW_COPY, signal: abort.signal });
    // On old code nothing is ever seen running; abort anyway so the test fails on the result, not a timeout.
    await untilCopyRuns(ch, 10_000);
    abort.abort();
    await expect(run).rejects.toThrow(/abort/);
    expect(await runningCopies(ch)).toBe(0);
    expect((await ch.client.exec(
      "SELECT count() FROM tokenlayer.session_events_monthly WHERE startsWith(path, 'bulk-')")).trim()).toBe("20000");
  }, 60_000);

  test("S2: a rerun does not copy again a day whose rows already arrived", async () => {
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0, maxParts: 0 })).state).toBe("partial");
    // As if an earlier run's copy landed in full and then died before DROP PART.
    const cols = "machine, harness, path, generation, byte_offset, content_hash, ts, ingested_at, raw";
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (${cols}) SELECT ${cols} FROM tokenlayer.session_events_monthly
      WHERE harness = 'antigravity' OR toYYYYMM(ts) = 197001 OR toDateTime(ts) + INTERVAL 30 DAY > now() SETTINGS max_partitions_per_insert_block = 0`);
    await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events");
    // 5, not 6: an insert block collapses recent-a's two versions (optimize_on_insert), as the copy's own blocks do.
    const before = (await ch.client.exec("SELECT count() FROM tokenlayer.session_events")).trim();
    expect(before).toBe("5");
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0 })).state).toBe("done");
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.session_events")).trim()).toBe(before);
    expect(await finalRows()).toEqual(expected);
  }, 60_000);

  test("S3: --dry-run sends only SELECTs in every resumable state", async () => {
    await ch.stop();
    ch = await startLocalClickHouse({ queryLog: true });
    await ch.client.exec("CREATE DATABASE tokenlayer");
    await ch.client.exec(legacyMonthlyDDL());
    await applySchema(ch.client);
    await insert(ch, "session_events", [row("recent-b", "codex", "now64(3, 'UTC') - INTERVAL 25 DAY")]);
    const writesDuring = async (fn: () => Promise<unknown>) => {
      const since = (await ch.client.exec("SELECT toString(now64(6))")).trim();
      await fn();
      await ch.client.exec("SYSTEM FLUSH LOGS");
      return (await ch.client.queryJSON<{ query: string }>(
        `SELECT query FROM system.query_log WHERE type = 'QueryStart' AND event_time_microseconds >= toDateTime64('${since}', 6)
         AND query_kind != 'Select' AND NOT startsWith(query, 'SYSTEM FLUSH LOGS') AND NOT startsWith(query, 'SELECT toString(now64')`)).map(r => r.query);
    };
    const dry = () => repartitionSessionEvents(ch.client, { floorBytes: 0, dryRun: true });
    // Fresh monthly table.
    expect(await writesDuring(dry)).toEqual([]);
    // Crashed after EXCHANGE, before RENAME: the monthly table is session_events_daily_next.
    const ddl = readFileSync(new URL("../../schema/004_session_events.sql", import.meta.url), "utf8")
      .replace("CREATE TABLE IF NOT EXISTS tokenlayer.session_events", "CREATE TABLE tokenlayer.session_events_daily_next");
    await ch.client.exec(ddl);
    await ch.client.exec("EXCHANGE TABLES tokenlayer.session_events AND tokenlayer.session_events_daily_next");
    const exchanged = await tables();
    expect(await writesDuring(dry)).toEqual([]);
    expect(await tables()).toEqual(exchanged);
    // Resumed with the archive in place.
    await ch.client.exec("RENAME TABLE tokenlayer.session_events_daily_next TO tokenlayer.session_events_monthly");
    expect(await writesDuring(dry)).toEqual([]);
  }, 60_000);

  test("S4: the back-out statements put the monthly table back live with its merges running", async () => {
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0, maxParts: 1 })).state).toBe("partial");
    // The archive's merges are stopped during the window, so a plain EXCHANGE back would leave them stopped.
    await expect(ch.client.exec("OPTIMIZE TABLE tokenlayer.session_events_monthly FINAL")).rejects.toThrow();
    for (const sql of repartition.BACK_OUT_SQL) await ch.client.exec(sql);
    expect((await tables()).find(t => t.name === "session_events")?.partition_key).toBe("toYYYYMM(ts)");
    await insert(ch, "session_events", [row("after-back-out", "claude", "now64(3, 'UTC') - INTERVAL 2 DAY")]);
    await ch.client.exec("OPTIMIZE TABLE tokenlayer.session_events FINAL");
  }, 60_000);

  test("N5: a stored archive column the daily table lacks stops the copy instead of being dropped", async () => {
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0, maxParts: 0 })).state).toBe("partial");
    await ch.client.exec("ALTER TABLE tokenlayer.session_events_monthly ADD COLUMN extra_col String DEFAULT 'x'");
    await expect(repartitionSessionEvents(ch.client, { floorBytes: 0 })).rejects.toThrow(/extra_col/);
  }, 60_000);
  test("N1: an insert that started before the exchange keeps the archive until it ends", async () => {
    const { url } = ch.client.config;
    // Resolved the monthly table before the run; still writing (slowly) when the copy finishes.
    const writer = fetch(`${url}/?query_id=old-ship-insert`, { method: "POST", body:
      `INSERT INTO tokenlayer.session_events (machine, harness, path, generation, byte_offset, content_hash, ts, raw)
       SELECT 'm4', 'claude', 'late', 'g1', number, toString(number), now64(3, 'UTC') - INTERVAL 1 DAY, 'x' FROM numbers(1000000000)
       SETTINGS max_threads = 1, max_block_size = 100, max_execution_speed = 1000, timeout_before_checking_execution_speed = 0` })
      .then(r => r.text()).catch(() => "");
    try {
      for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(50)) {
        if ((await ch.client.exec("SELECT count() FROM system.processes WHERE query_id = 'old-ship-insert'")).trim() === "1") break;
      }
      await Bun.sleep(1100);
      const report = await repartitionSessionEvents(ch.client, { floorBytes: 0 });
      expect(report.state).toBe("partial");
      expect(report.stopped).toMatch(/old-ship-insert/);
      expect((await tables()).map(t => t.name)).toEqual(["session_events", "session_events_monthly"]);
    } finally {
      await ch.client.exec("KILL QUERY WHERE query_id = 'old-ship-insert' SYNC");
      await writer;
    }
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0 })).state).toBe("done");
  }, 60_000);

  // ---- Round 2 (re-review S5–S10) ----
  const archiveCount = async (where = "1") =>
    Number((await ch.client.exec(`SELECT count() FROM tokenlayer.session_events_monthly WHERE ${where}`)).trim());
  const liveCount = async (where = "1") => Number((await ch.client.exec(`SELECT count() FROM tokenlayer.session_events WHERE ${where}`)).trim());
  /** A fresh monthly table holding only what `fill` inserts. */
  async function freshMonthly(fill: () => Promise<unknown>) {
    await ch.client.exec("DROP TABLE tokenlayer.session_events SYNC");
    await ch.client.exec(legacyMonthlyDDL());
    await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events");
    await fill();
  }
  const partBytes = async (table: string) => Number((await ch.client.exec(
    `SELECT sum(bytes_on_disk) FROM system.parts WHERE database = 'tokenlayer' AND table = '${table}' AND active`)).trim());
  /** One insert (one part) of `n` claude rows spread evenly over `days` recent UTC days, `text` bytes of incompressible raw each. */
  const spread = (n: number, days: number, text: (i: string) => string = () => "'x'") => ch.client.exec(
    `INSERT INTO tokenlayer.session_events (machine, harness, path, generation, byte_offset, content_hash, line_bytes, ts, ingested_at, raw)
     SELECT 'm4', 'claude', concat('spread-', toString(number)), 'g1', number, toString(number), length(${text("number")}),
       toStartOfDay(now64(3, 'UTC')) - INTERVAL 5 DAY + toIntervalDay(number % ${days}) + INTERVAL 1 HOUR, now64(3, 'UTC') - INTERVAL 1 HOUR, ${text("number")}
     FROM numbers(${n})`);

  test("S5: a day is sized by its text, so a day with few rows but most of the bytes sets the need", async () => {
    // Days 1 and 3: 450 tiny rows each. Day 2: 100 rows carrying nearly all the bytes. By rows the largest day is 45%
    // of the part; by bytes, day 2 is about 97%.
    await freshMonthly(() => ch.client.exec(
      `INSERT INTO tokenlayer.session_events (machine, harness, path, generation, byte_offset, content_hash, line_bytes, ts, ingested_at, raw)
       SELECT 'm4', 'claude', concat('s5-', toString(number)), 'g1', number, toString(number), length(raw),
         toStartOfDay(now64(3, 'UTC')) - INTERVAL 5 DAY + toIntervalDay(if(number < 100, 1, if(number < 550, 0, 2))) + INTERVAL 1 HOUR,
         now64(3, 'UTC') - INTERVAL 1 HOUR, if(number < 100, randomPrintableASCII(20000), 'x') AS raw
       FROM numbers(1000)`));
    const bytes = await partBytes("session_events");
    const plan = await repartitionSessionEvents(ch.client, { floorBytes: 0, killMarginBytes: 0, dryRun: true });
    expect(plan.remaining).toHaveLength(1);
    expect(plan.remaining[0].maxDayBytes).toBeGreaterThan(0.9 * bytes);
    expect(plan.needBytes).toBeGreaterThan(1.1 * bytes + 3 * 0.9 * bytes);
  }, 60_000);

  test("S5/N8: a resumed run tests what is left of a part before copying any of it", async () => {
    await freshMonthly(() => spread(4000, 4));
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0, maxParts: 0 })).state).toBe("partial"); // swap only
    const bytes = await partBytes("session_events_monthly");
    const floorBytes = 2 ** 40;
    // Room for the part once: each quarter-day passes "free - 3 x day >= floor", the whole part does not.
    const report = await repartitionSessionEvents(ch.client, { floorBytes, killMarginBytes: 0, settleMs: 0, freeBytes: async () => floorBytes + bytes });
    expect(report.state).toBe("partial");
    expect(report.stopped).toMatch(/4 days left to copy/);
    expect(await liveCount()).toBe(0);
    expect(await archiveCount()).toBe(4000);
  }, 60_000);

  const lowWhileCopying = (low: () => Promise<number>) => async () => (await runningCopies(ch)) ? low() : 2 ** 50;

  test("S6: the watchdog kills at the floor plus a margin, before the floor itself breaks", async () => {
    await freshMonthly(() => bulk(ch, 20_000)); // only the slow part, so a low read always lands during its copy
    const floorBytes = 2 ** 40;
    const report = await repartitionSessionEvents(ch.client, {
      floorBytes, freeBytes: lowWhileCopying(async () => floorBytes + 2 ** 30), extraCopySettings: SLOW_COPY, watchMs: 100,
    });
    expect(report.state).toBe("partial");
    expect(report.stopped).toMatch(/kill margin/);
    expect(await runningCopies(ch)).toBe(0);
    expect(await archiveCount("startsWith(path, 'bulk-')")).toBe(20000);
  }, 60_000);

  test("S7: free disk that cannot be read counts as unsafe and kills the copy", async () => {
    await freshMonthly(() => bulk(ch, 20_000)); // only the slow part, so a low read always lands during its copy
    const report = await repartitionSessionEvents(ch.client, {
      floorBytes: 2 ** 40, freeBytes: lowWhileCopying(async () => { throw new Error("memory limit (total) exceeded"); }),
      extraCopySettings: SLOW_COPY, watchMs: 100,
    });
    expect(report.state).toBe("partial");
    expect(report.stopped).toMatch(/could not be read 3 times/);
    expect(await runningCopies(ch)).toBe(0);
    expect(await liveCount("startsWith(path, 'bulk-')")).toBeLessThan(20000);
  }, 60_000);

  /**
   * The client with its first `n` KILL statements answered but never sent, like a KILL that runs before the query is
   * listed. Its copies sleep 0.3 ms a row (about 6 s for the bulk day; ClickHouse caps a sleep at 3 s per 8192-row
   * granule): SLOW_COPY's speed limit let a CI copy end within 1.5 s.
   */
  const losingKills = (n: number) => {
    let lost = 0;
    return new Proxy(ch.client, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return (sql: string, o?: { queryId?: string }) => {
            if (/^\s*KILL /.test(sql) && lost++ < n) return Promise.resolve("");
            const slowed = o?.queryId?.startsWith("r12-") ? sql.replace(/\n\s*SETTINGS /, " AND sleepEachRow(0.0003) = 0\n SETTINGS ") : sql;
            if (o?.queryId?.startsWith("r12-") && slowed === sql) throw new Error("test proxy could not slow the copy");
            return target.exec(slowed, o);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  test("S7: a KILL that did nothing is re-issued until the copy is gone", async () => {
    await freshMonthly(() => bulk(ch, 20_000)); // only the slow part, so a low read always lands during its copy
    const report = await repartitionSessionEvents(losingKills(1), {
      floorBytes: 2 ** 40, freeBytes: lowWhileCopying(async () => 0), extraCopySettings: SLOW_COPY, watchMs: 100,
    });
    expect(report.state).toBe("partial");
    expect(await runningCopies(ch)).toBe(0);
    // The old watchdog stopped watching after its one KILL, and the copy ran to the end.
    expect(await liveCount("startsWith(path, 'bulk-')")).toBeLessThan(20000);
  }, 60_000);

  test("S7: a kill that cannot be confirmed stops the run loudly", async () => {
    await freshMonthly(() => bulk(ch, 20_000)); // only the slow part, so a low read always lands during its copy
    try {
      const outcome = await repartitionSessionEvents(losingKills(Infinity), {
        floorBytes: 2 ** 40, freeBytes: lowWhileCopying(async () => 0), extraCopySettings: SLOW_COPY, watchMs: 100, killConfirmMs: 1500,
      }).then(report => ({ report }), error => ({ error: String(error) }));
      expect(outcome).toEqual({ error: expect.stringMatching(/not confirmed.*may still be writing/) });
    } finally {
      await ch.client.exec("KILL QUERY WHERE startsWith(query_id, 'r12-') SYNC").catch(() => {}); // 26.11 throws when none runs
    }
    expect(await archiveCount("startsWith(path, 'bulk-')")).toBe(20000);
  }, 60_000);

  test("S9: no swap while a shipper runs a client that cannot write over 100 days at once", async () => {
    const shipperCheck = async () => ["M4 (macbook-pro): old client"];
    await expect(repartition.repartitionSessionEvents(ch.client, { floorBytes: 0, shipperCheck })).rejects.toThrow(/shippers not ready.*M4.*nothing changed/);
    expect(await tables()).toEqual([{ name: "session_events", partition_key: "toYYYYMM(ts)" }]);
    const plan = await repartition.repartitionSessionEvents(ch.client, { floorBytes: 0, shipperCheck, dryRun: true });
    expect(plan.refusal).toMatch(/shipper not ready: M4/);
  }, 60_000);

  test("S10: the back-out renames the daily table unmistakably and its copy-back restores every row", async () => {
    expect((await repartitionSessionEvents(ch.client, { floorBytes: 0, maxParts: 1 })).state).toBe("partial");
    // Shipped during the window: only the daily table has it.
    await insert(ch, "session_events", [row("window-row", "codex", "now64(3, 'UTC') - INTERVAL 1 DAY", "now64(3, 'UTC')")]);
    for (const sql of repartition.BACK_OUT_SQL) await ch.client.exec(sql);
    expect(await tables()).toEqual([
      { name: "session_events", partition_key: "toYYYYMM(ts)" },
      { name: "session_events_daily_backed_out", partition_key: "toYYYYMMDD(ts)" },
    ]);
    const days = await ch.client.queryJSON<{ day: string; bytes: string }>(repartition.COPY_BACK_DAYS_SQL);
    expect(days.length).toBeGreaterThan(0);
    for (const { day } of days) {
      const step = repartition.copyBackSQL(day);
      await ch.client.exec(step.insert);
      expect((await ch.client.exec(step.check)).trim()).toBe("0");
      await ch.client.exec(step.drop);
    }
    expect(await ch.client.queryJSON(repartition.COPY_BACK_DAYS_SQL)).toEqual([]);
    await ch.client.exec(`DROP TABLE ${repartition.BACKED_OUT} SYNC`);
    // The restored monthly table may still hold the expired row (its TTL merge has not run yet); every kept row is back.
    expect(await finalRows()).toEqual(expect.arrayContaining([...expected, { path: "window-row", harness: "codex" }]));
    expect((await ch.client.exec("SELECT sum(raw_has_message) + countIf(raw = '') FROM tokenlayer.session_events")).trim()).toBe("0");
  }, 60_000);
});
