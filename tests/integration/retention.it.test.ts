import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

describe.skipIf(!clickhouseBinary())("thirty-day retention → real local ClickHouse", () => {
  let local: LocalClickHouse;
  beforeAll(async () => { local = await startLocalClickHouse({ prepare: applySchema }); }, 40_000);
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

describe.skipIf(!clickhouseBinary())("retention metadata migration → real local ClickHouse", () => {
  let local: LocalClickHouse;
  beforeAll(async () => { local = await startLocalClickHouse(); }, 40_000);
  afterAll(async () => { await local?.stop(); });
  test("applying schema twice creates no session mutation and skips the installed TTL", async () => {
    // Seed a pre-retention table with an existing part. system.mutations retains
    // completed mutations too, so a fast worker cannot hide the regression.
    await local.client.exec("CREATE DATABASE tokenlayer");
    const { readFileSync } = await import("node:fs");
    await local.client.exec(readFileSync(new URL("../../schema/004_session_events.sql", import.meta.url), "utf8"));
    await local.client.exec("INSERT INTO tokenlayer.session_events (machine, harness, path, ts) VALUES ('fixture', 'claude', 'pre-retention', now() - INTERVAL 40 DAY)");
    const mutations = () => local.client.queryJSON("SELECT mutation_id FROM system.mutations WHERE database = 'tokenlayer' AND table = 'session_events' ORDER BY mutation_id");
    const before = await mutations();
    expect(before).toEqual([]);
    await applySchema(local.client);
    expect(await mutations()).toEqual(before);
    const ddl = await local.client.exec("SHOW CREATE TABLE tokenlayer.session_events");
    const exec = local.client.exec.bind(local.client);
    const retentionStatements: string[] = [];
    local.client.exec = async (sql) => {
      if (/MODIFY (TTL|SETTING)/i.test(sql)) retentionStatements.push(sql);
      return exec(sql);
    };
    await applySchema(local.client);
    expect(await mutations()).toEqual(before);
    expect(retentionStatements).toEqual([]);
    expect(await local.client.exec("SHOW CREATE TABLE tokenlayer.session_events")).toBe(ddl);
    // Repair actual metadata drift rather than trusting that the file ran before.
    await exec("ALTER TABLE tokenlayer.session_events MODIFY TTL toDateTime(ts) + INTERVAL 90 DAY SETTINGS materialize_ttl_after_modify = 0");
    await exec("ALTER TABLE tokenlayer.session_events MODIFY SETTING merge_with_ttl_timeout = 7200");
    await exec("ALTER TABLE tokenlayer.proxy_usage MODIFY SETTING max_bytes_to_merge_at_max_space_in_pool = 2147483648");
    await applySchema(local.client);
    expect(await local.client.exec("SHOW CREATE TABLE tokenlayer.session_events")).toBe(ddl);
    expect(await local.client.exec("SHOW CREATE TABLE tokenlayer.proxy_usage"))
      .toContain("max_bytes_to_merge_at_max_space_in_pool = 1073741824");
    expect(await mutations()).toEqual(before);
  }, 40_000);
});
