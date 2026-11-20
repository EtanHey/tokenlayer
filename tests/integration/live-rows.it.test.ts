import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { LIVE_QUERY_SQL } from "../../ratchet/live-sql";
// @ts-expect-error untyped ratchet judge
import { evaluate } from "../../ratchet/table.mjs";

const rows = JSON.parse(readFileSync(join(import.meta.dir, "../../ratchet/rows.json"), "utf8")).rows as { id: string; command: string }[];
const row = (id: string) => rows.find((r) => r.id === id)!;

/** One session_events row: event `tsAgo` seconds before now (or 1970), first ingested `ingestAgo` seconds before now. */
type Event = { machine: string; path: string; offset: number; hash?: string; generation?: string; tsAgo: number | "1970"; ingestAgo: number };
/** Absolute times, as a shipper writes them: a replayed line carries exactly the ts of the original. */
let base = Date.now();
const at = (secondsAgo: number) => `toDateTime64('${new Date(base - secondsAgo * 1000).toISOString().replace("T", " ").replace("Z", "")}', 3, 'UTC')`;
const value = (e: Event) => `('${e.machine}', 'claude', '${e.path}', '${e.path}', '${e.generation ?? "g1"}', ${e.offset}, '${e.hash ?? `${e.path}-${e.offset}`}', `
  + `${e.tsAgo === "1970" ? "toDateTime64(0, 3, 'UTC')" : at(e.tsAgo)}, ${at(e.ingestAgo)})`;
const range = (n: number, f: (i: number) => Event) => Array.from({ length: n }, (_, i) => f(i));

describe.skipIf(!clickhouseBinary())("live rows shipper_live_lag_s and ch_live_query_p95_ms → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  let home: string;
  beforeAll(async () => {
    ch = await startLocalClickHouse({ prepare: applySchema });
    home = mkdtempSync(join(tmpdir(), "live-rows-"));
  }, 40000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const reset = async (events: Event[]) => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.session_events");
    await ch.client.exec("TRUNCATE TABLE tokenlayer.session_first_ingest");
    base = Date.now();
    if (events.length) await ch.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, session_id, generation, byte_offset, content_hash, ts, ingested_at) VALUES ${events.map(value).join(", ")}`);
  };
  /** The row's own command against the local server; HOME is empty so no real credentials are read. */
  const measure = (id: string) => {
    const run = Bun.spawnSync(["bash", "-c", row(id).command], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, HOME: home, CLICKHOUSE_URL: ch.client.config.url, CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "", CLICKHOUSE_DB: "tokenlayer" },
    });
    expect({ exit: run.exitCode, stderr: run.stderr.toString().slice(-500) }).toEqual({ exit: 0, stderr: "" });
    return Number(run.stdout.toString().trim().split("\n").pop());
  };
  const live = (machine: string, n: number, lag: number) => range(n, (i) => ({ machine, path: `${machine}-live`, offset: i, tsAgo: 30 * 60 - i * 30, ingestAgo: 30 * 60 - i * 30 - lag }));

  test("live shippers read green although 1970 rows, history replays and a generation replay landed just now", async () => {
    await reset([
      ...live("m1", 40, 5),
      ...live("m4", 40, 8),
      ...range(30, (i) => ({ machine: "m4", path: "antigravity-import", offset: i, tsAgo: "1970", ingestAgo: 60 })),
      ...range(30, (i) => ({ machine: "m4", path: "history-replay", offset: i, tsAgo: 20 * 86400 + i, ingestAgo: 30 })),
      // A rewritten file re-ships its live events under a new generation: same ts and content, ingested much later.
      ...range(20, (i) => ({ machine: "m1", path: "m1-live", offset: i, hash: `m1-live-${i}`, generation: "g2", tsAgo: 30 * 60 - i * 30, ingestAgo: 10 })),
    ]);
    const lag = measure("shipper_live_lag_s");
    expect(lag).toBeGreaterThanOrEqual(5);
    expect(lag).toBeLessThanOrEqual(8.5);
    expect(evaluate(row("shipper_live_lag_s"), lag)).toBe(true);
  });

  test("same-key replay stays green after replacement and first-ingest aggregate merges", async () => {
    const events = live("m1", 40, 5);
    await reset(events);
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, session_id, generation, byte_offset, content_hash, ts, ingested_at) VALUES ${events.map(e => value({ ...e, ingestAgo: 1 })).join(", ")}`);
    await ch.client.exec("OPTIMIZE TABLE tokenlayer.session_events FINAL");
    await ch.client.exec("OPTIMIZE TABLE tokenlayer.session_first_ingest FINAL");
    expect(Number((await ch.client.exec("SELECT count() FROM tokenlayer.session_events FINAL")).trim())).toBe(40);
    const lag = measure("shipper_live_lag_s");
    expect(lag).toBe(5);
    expect(evaluate(row("shipper_live_lag_s"), lag)).toBe(true);
  });

  test("a shipper that stopped for 20 min and then caught up trips the row, even when the other machine ships far more", async () => {
    await reset([
      ...live("m1", 400, 5).map((e, i) => ({ ...e, path: `m1-busy-${i % 7}` })),
      // m4's shipper stopped 20 min ago and restarted 30 s ago: its backlog landed in one go.
      ...range(30, (i) => ({ machine: "m4", path: "m4-live", offset: i, tsAgo: 20 * 60 - i * 30, ingestAgo: 30 })),
    ]);
    const lag = measure("shipper_live_lag_s");
    expect(lag).toBeGreaterThan(60);
    expect(evaluate(row("shipper_live_lag_s"), lag)).toBe(false);
  });

  test("no live events in the window reads 0 (nothing is waiting), not MISSING", async () => {
    await reset(range(5, (i) => ({ machine: "m4", path: "antigravity-import", offset: i, tsAgo: "1970", ingestAgo: 5 })));
    expect(measure("shipper_live_lag_s")).toBe(0);
  });

  test("the live query prunes old partitions under FINAL and returns what plain FINAL returns", async () => {
    // Two versions of each recent key (an insert retry) plus a 1970 partition.
    const recent = range(50, (i) => ({ machine: "m1", path: `s${i % 5}`, offset: i, tsAgo: 3600 + i, ingestAgo: 60 }));
    await reset([...recent, ...range(20, (i) => ({ machine: "m4", path: "agy", offset: i, tsAgo: "1970" as const, ingestAgo: 60 }))]);
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, session_id, generation, byte_offset, content_hash, ts, ingested_at) VALUES ${recent.map((e) => value({ ...e, ingestAgo: 1 })).join(", ")}`);
    const plan = await ch.client.exec(`EXPLAIN indexes = 1 ${LIVE_QUERY_SQL}`);
    const [, selected, total] = plan.match(/Parts: (\d+)\/(\d+)/)!;
    expect(Number(selected)).toBeLessThan(Number(total));
    const answer = async (sql: string) => (await ch.client.exec(sql)).trim().split("\n").sort();
    const plain = "SELECT session_id, count() FROM tokenlayer.session_events FINAL WHERE ts>now()-INTERVAL 1 DAY GROUP BY session_id";
    expect(await answer(LIVE_QUERY_SQL)).toEqual(["s0\t10", "s1\t10", "s2\t10", "s3\t10", "s4\t10"]);
    expect(await answer(LIVE_QUERY_SQL)).toEqual(await answer(plain));
    expect(Number.isFinite(measure("ch_live_query_p95_ms"))).toBe(true);
  });
});
