import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { parseLine } from "../../src/ship/parse";

// R7: the provider compare (and the context view inside it) read raw — 51 GiB uncompressed on the M1 — for a handful
// of facts: whether a stream has created_at or message lines, Codex rate limits and token_count totals. Those facts
// are MATERIALIZED columns of session_events, so no view read decompresses raw. Parts written before the columns
// existed compute them from raw on read, so the views stay correct before the MATERIALIZE COLUMN backfill.
const FACTS = ["raw_has_created_at", "raw_has_message", "token_total", "codex_primary_pct", "codex_primary_minutes",
  "codex_secondary_pct", "codex_secondary_minutes"];
const COMPARE = `SELECT day, provider, tokens, peak_5h_used_pct, peak_weekly_used_pct FROM tokenlayer.v_provider_usage_compare
  WHERE provider IN ('claude', 'codex', 'antigravity') ORDER BY day, provider`;
const EXPECTED = [
  { day: "2026-11-03", provider: "antigravity", tokens: 10, peak_5h_used_pct: null, peak_weekly_used_pct: null },
  { day: "2026-11-03", provider: "claude", tokens: 35, peak_5h_used_pct: null, peak_weekly_used_pct: null },
  // Two token_count lines repeat the same cumulative total: only the first is credited (10 + 20 + 5).
  { day: "2026-11-03", provider: "codex", tokens: 35, peak_5h_used_pct: 40, peak_weekly_used_pct: 30 },
];

async function insertFixture(ch: LocalClickHouse) {
  let offset = 0;
  // harness t3 everywhere, so only raw tells the provider apart (created_at → antigravity, message → claude).
  const put = (path: string, raw: unknown, extras = {}) => ch.client.insert("session_events", [{
    ...parseLine(JSON.stringify(raw)), machine: "fixture", path, harness: "t3", generation: "g1", byte_offset: offset++,
    content_hash: `h${offset}`, line_bytes: 1, ingested_at: "2026-11-03 04:00:00.000", ...extras,
  }]);
  await put("claude.jsonl", { timestamp: "2026-11-03T03:00:00Z", type: "assistant", sessionId: "claude", message: { id: "msg", role: "assistant", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 } } });
  const tokenCount = (pct: number) => ({ timestamp: "2026-11-03T03:00:00Z", type: "event_msg", payload: { type: "token_count",
    rate_limits: { primary: { used_percent: pct, window_minutes: 300 }, secondary: { used_percent: 30, window_minutes: 10080 } },
    info: { total_token_usage: { total_tokens: 55 }, last_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5 } } } });
  await put("codex.jsonl", tokenCount(12));
  await put("codex.jsonl", tokenCount(40));
  await put("agy.jsonl", { created_at: "2026-11-03T03:00:00Z" }, { ts: "2026-11-03 03:00:00.000", input_tokens: 7, output_tokens: 3 });
}

describe.skipIf(!clickhouseBinary())("raw facts are insert-time columns → real local ClickHouse", () => {
  test("the provider compare and the context view read no raw", async () => {
    const ch = await startLocalClickHouse({ queryLog: true });
    try {
      await applySchema(ch.client);
      await insertFixture(ch);
      expect(await ch.client.queryJSON(`${COMPARE} SETTINGS log_comment='r7-compare'`)).toEqual(EXPECTED);
      expect(await ch.client.queryJSON(`SELECT harness, sum(output_tokens) AS t FROM tokenlayer.v_session_events_context
        GROUP BY harness SETTINGS log_comment='r7-context'`)).toEqual([{ harness: "t3", t: 13 }]);
      await ch.client.exec("SYSTEM FLUSH LOGS");
      const read = await ch.client.queryJSON<{ log_comment: string; raw: number; facts: number }>(`SELECT log_comment,
        has(columns, 'tokenlayer.session_events.raw') AS raw, length(arrayFilter(c -> startsWith(c, 'tokenlayer.session_events.'),
        columns)) > 0 AS facts FROM system.query_log WHERE type = 'QueryFinish' AND log_comment LIKE 'r7-%' ORDER BY log_comment`);
      expect(read).toEqual([{ log_comment: "r7-compare", raw: 0, facts: 1 }, { log_comment: "r7-context", raw: 0, facts: 1 }]);
    } finally { await ch.stop(); }
  }, 60000);

  test("parts written before the columns: adding them is metadata only and the views answer the same before and after MATERIALIZE COLUMN", async () => {
    const ch = await startLocalClickHouse();
    try {
      // The pre-R7 table: schema/004 without the MATERIALIZED columns.
      const legacy = readFileSync(join(import.meta.dir, "../../schema/004_session_events.sql"), "utf8")
        .split("\n").filter((l) => !/\bMATERIALIZED\b/.test(l)).join("\n").replace(/;\s*$/, "");
      await ch.client.exec("CREATE DATABASE tokenlayer");
      await ch.client.exec(legacy);
      await insertFixture(ch);
      const parts = () => ch.client.queryJSON("SELECT name, modification_time, bytes_on_disk FROM system.parts WHERE database = 'tokenlayer' AND table = 'session_events' AND active ORDER BY name");
      const before = await parts();
      await applySchema(ch.client);
      expect(await ch.client.queryJSON<{ name: string; default_kind: string }>(`SELECT name, default_kind FROM system.columns
        WHERE database = 'tokenlayer' AND table = 'session_events' AND default_kind = 'MATERIALIZED' ORDER BY position`))
        .toEqual(FACTS.map((name) => ({ name, default_kind: "MATERIALIZED" })));
      // Metadata only: no mutation, the old parts are untouched and hold no file for the new columns.
      expect(await ch.client.queryJSON("SELECT count() AS n FROM system.mutations WHERE database = 'tokenlayer'")).toEqual([{ n: 0 }]);
      expect(await parts()).toEqual(before);
      expect(await ch.client.queryJSON("SELECT count() AS n FROM system.parts_columns WHERE database = 'tokenlayer' AND table = 'session_events' AND active AND column = 'raw_has_message'")).toEqual([{ n: 0 }]);
      expect(await ch.client.queryJSON(COMPARE)).toEqual(EXPECTED);
      // The backfill (docs/telemetry.md): one mutation, which hard-links raw and writes only the new columns.
      await ch.client.exec(`ALTER TABLE tokenlayer.session_events ${FACTS.map((c) => `MATERIALIZE COLUMN ${c}`).join(", ")} SETTINGS mutations_sync = 2`);
      expect(await ch.client.queryJSON("SELECT uniqExact(mutation_id) AS files, countIf(NOT is_done) AS pending FROM system.mutations WHERE database = 'tokenlayer'"))
        .toEqual([{ files: 1, pending: 0 }]);
      // Each part is rewritten once (one inactive predecessor each), not once per column.
      expect(await ch.client.queryJSON("SELECT countIf(NOT active) AS old, countIf(active) AS live FROM system.parts WHERE database = 'tokenlayer' AND table = 'session_events'"))
        .toEqual([{ old: before.length, live: before.length }]);
      expect(await ch.client.queryJSON(`SELECT count() AS n FROM system.parts_columns WHERE database = 'tokenlayer' AND table = 'session_events'
        AND active AND column = 'raw_has_message'`)).toEqual([{ n: before.length }]);
      expect(await ch.client.queryJSON(COMPARE)).toEqual(EXPECTED);
    } finally { await ch.stop(); }
  }, 60000);
});
