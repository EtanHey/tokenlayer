import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

describe.skipIf(!clickhouseBinary())("thirty-day retention → real local ClickHouse", () => {
  let local: LocalClickHouse;
  beforeAll(async () => { local = await startLocalClickHouse(); await applySchema(local.client); }, 40_000);
  afterAll(async () => { await local?.stop(); });
  test("TTL removes only expired ordinary rows, preserves AGY and January 1970; reapplies safely", async () => {
    await local.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, ts)
      VALUES ('fixture', 'claude', 'expired', now() - INTERVAL 40 DAY),
             ('fixture', 'codex', 'recent', now() - INTERVAL 10 DAY),
             ('fixture', 'antigravity', 'protected-agy', now() - INTERVAL 40 DAY),
             ('fixture', 't3', 'undated', toDateTime64(0, 3, 'UTC')),
             ('fixture', 'claude', 'january-1970', toDateTime64(86400, 3, 'UTC'))`);
    await applySchema(local.client);
    await local.client.exec("OPTIMIZE TABLE tokenlayer.session_events FINAL");
    expect(await local.client.queryJSON("SELECT path FROM tokenlayer.session_events FINAL ORDER BY path"))
      .toEqual(["january-1970", "protected-agy", "recent", "undated"].map(path => ({ path })));
  });
  test("fresh and migrated tables retain the one-GiB merge cap and hourly TTL cadence", async () => {
    for (const table of ["session_events", "proxy_usage"]) {
      const ddl = await local.client.exec(`SHOW CREATE TABLE tokenlayer.${table}`);
      expect(ddl).toContain("max_bytes_to_merge_at_max_space_in_pool = 1073741824");
      if (table === "session_events") expect(ddl).toContain("merge_with_ttl_timeout = 3600");
    }
  });
});
