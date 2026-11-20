import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportExisting } from "../../src/archaeology/existing";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

// Canary that the server honours the setting where it is written, not a wanted behaviour: real versions of a key
// never span partitions (every version carries the same line, so the same ts). This fixture forces one across a
// month boundary, so a per-partition FINAL keeps both versions and a plain FINAL keeps one.
describe.skipIf(!clickhouseBinary())("per-partition FINAL is in effect → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  let dir: string;
  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    const row = (ts: string, ingested: string) => `('m4', 'claude', '/s/0a1b2c3d-0000-4000-8000-000000000001.jsonl', 'g1', 0, '${"a".repeat(64)}', toDateTime64('${ts}', 3, 'UTC'), toDateTime64('${ingested}', 3, 'UTC'))`;
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, generation, byte_offset, content_hash, ts, ingested_at) VALUES ${row("2026-10-31 23:59:00", "2026-11-01 00:00:00")}`);
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (machine, harness, path, generation, byte_offset, content_hash, ts, ingested_at) VALUES ${row("2026-11-01 00:01:00", "2026-11-01 00:02:00")}`);
    mkdirSync(".local", { recursive: true });
    dir = realpathSync(mkdtempSync(".local/final-per-partition-"));
  }, 40000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("plain FINAL still collapses the forced cross-partition key (the fixture is real)", async () => {
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.session_events FINAL")).trim()).toBe("1");
  });
  test("v_session_events_context reads session_events per partition, whatever the caller sets", async () => {
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.v_session_events_context")).trim()).toBe("2");
    expect((await ch.client.exec("SELECT count() FROM tokenlayer.v_session_events_context SETTINGS do_not_merge_across_partitions_select_final=0")).trim()).toBe("2");
  });
  test("archaeology existing export reads session_events per partition", async () => {
    const out = join(dir, "existing.tsv");
    await exportExisting(ch.client, out);
    expect(readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => line.split("\t").pop())).toEqual(["2"]);
  });
});
