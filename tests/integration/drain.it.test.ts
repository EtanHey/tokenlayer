import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/usage-queue.json";
import { applySchema } from "../../src/lib/schema";
import { drainOnce } from "../../src/drain/drain";
import { Spool } from "../../src/drain/spool";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

describe.skipIf(!clickhouseBinary())("drain → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  let dir: string;

  beforeAll(async () => {
    ch = await startLocalClickHouse();
    dir = mkdtempSync(join(tmpdir(), "tokenlayer-it-"));
  }, 40_000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("schema applies twice (idempotent) and creates all tables", async () => {
    await applySchema(ch.client);
    await applySchema(ch.client);
    const tables = await ch.client.queryJSON<{ name: string }>(
      "SELECT name FROM system.tables WHERE database = 'tokenlayer' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(["credentials_snap", "proxy_usage", "session_events", "v_requests", "v_session_events_context", "v_session_events_meta", "v_sessions_daily"]);
  });

  test("drained rows land with the right types; a retried batch adds no rows", async () => {
    const pages = [fixture];
    const hub = Bun.serve({ port: 0, fetch: () => Response.json(pages.shift() ?? []) });
    const spool = new Spool(dir);
    const result = await drainOnce({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch.client,
      spool,
    });
    hub.stop(true);
    expect(result).toEqual({ drained: 2, inserted: 2, spooled: 0, rejected: 0 });

    // Simulate an ambiguous failure: the same batch (same token) is re-sent.
    const rows = (await import("../../src/drain/record")).mapUsageRecord;
    const again = fixture.map((r) => rows(r, { hub: "m1" }));
    const token = "f".repeat(64);
    await ch.client.insert("proxy_usage", again, token);
    await ch.client.insert("proxy_usage", again, token);

    const [agg] = await ch.client.queryJSON<{ n: string; cache_read: string; failed: string; ratelimit_keys: string }>(
      `SELECT count() AS n, sum(cache_read_tokens) AS cache_read, countIf(failed) AS failed,
              length(mapKeys(argMax(ratelimit, input_tokens))) AS ratelimit_keys
       FROM tokenlayer.proxy_usage FINAL`,
    );
    expect(Number(agg.n)).toBe(2);
    expect(Number(agg.cache_read)).toBe(38000);
    expect(Number(agg.failed)).toBe(1);
    expect(Number(agg.ratelimit_keys)).toBe(3);

    const [ts] = await ch.client.queryJSON<{ ts: string }>(
      "SELECT toString(ts) AS ts FROM tokenlayer.proxy_usage FINAL WHERE model = 'claude-opus-5-5'",
    );
    expect(ts.ts).toBe("2026-10-28 07:31:07.123");
  });

  test("public rate-limit headers survive queue, spool and real proxy_usage", async () => {
    const headers = Object.fromEntries([
      ...['requests', 'tokens', 'input-tokens', 'output-tokens'].flatMap(b =>
        ['limit', 'remaining', 'reset'].map(f => `anthropic-ratelimit-${b}-${f}`)),
      ...['requests', 'tokens'].flatMap(b =>
        ['limit', 'remaining', 'reset'].map(f => `x-ratelimit-${f}-${b}`)),
      ...['5h', '7d'].flatMap(w => ['status', 'reset', 'utilization'].map(f => `anthropic-ratelimit-unified-${w}-${f}`)),
      'retry-after', 'x-codex-primary-reset-after-seconds',
    ].map((h, i) => [h, `${i}.125`]));
    const pages = [[{...fixture[0], execution_id: 'header-roundtrip', response_headers: headers}]];
    const hub = Bun.serve({port: 0, fetch: () => Response.json(pages.shift() ?? [])});
    try {
      await drainOnce({hubUrl: hub.url.toString(), mgmtKey: 'synthetic', hub: 'm1', clickhouse: ch.client, spool: new Spool(dir)});
      const rows = await ch.client.queryJSON<{ratelimit: Record<string, string>}>(
        "SELECT ratelimit FROM tokenlayer.proxy_usage WHERE execution_id = 'header-roundtrip'");
      expect(rows).toEqual([{ratelimit: headers}]);
    } finally { hub.stop(true); }
  });

  test("object failure bodies survive queue, spool and real proxy_usage losslessly", async () => {
    const body = { error: { message: `  ${"synthetic failure\nשלום".repeat(1000)}  `, details: [429, false, null] } };
    const pages = [[{ ...fixture[1], execution_id: "object-body-roundtrip", fail: { status_code: 500, body } }]];
    const hub = Bun.serve({ port: 0, fetch: () => Response.json(pages.shift() ?? []) });
    try {
      const result = await drainOnce({
        hubUrl: hub.url.toString(),
        mgmtKey: "synthetic",
        hub: "m1",
        clickhouse: ch.client,
        spool: new Spool(dir),
      });
      expect(result).toEqual({ drained: 1, inserted: 1, spooled: 0, rejected: 0 });
      const rows = await ch.client.queryJSON<{ fail_body: string }>(
        "SELECT fail_body FROM tokenlayer.proxy_usage WHERE execution_id = 'object-body-roundtrip'",
      );
      expect(rows).toEqual([{ fail_body: JSON.stringify(body) }]);
    } finally {
      hub.stop(true);
    }
  });

  test("a rejected insert throws, so the spool keeps the batch", async () => {
    const bad = [{ ts: "not-a-time", execution_id: "e-bad" }];
    await expect(ch.client.insert("proxy_usage", bad)).rejects.toThrow(/clickhouse insert into proxy_usage failed/);
    const [n] = await ch.client.queryJSON<{ n: string }>("SELECT count() AS n FROM tokenlayer.proxy_usage WHERE execution_id = 'e-bad'");
    expect(Number(n.n)).toBe(0);
  });

  test("every example query in docs/telemetry.md runs", async () => {
    const doc = await Bun.file(join(import.meta.dir, "..", "..", "docs", "telemetry.md")).text();
    const queries = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const q of queries) await ch.client.exec(q);
  });
});
