import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

// R5: the token sums and the provider compare must not hold raw in memory. On the M1 raw is 51 GiB uncompressed and the
// old views sorted it (the planner moved the token_count JSON extraction above the window sort) or read it under FINAL,
// so even a 1-day sum passed the reader's 8 GiB cap. Here 300 MB of raw runs under a 100 MB per-query cap: a view
// that streams raw passes, one that holds it fails with code 241.
const CAP = "SETTINGS max_memory_usage=100000000, max_threads=2";
const PAD = "repeat('x', 100000)";

describe.skipIf(!clickhouseBinary())("token-sum views run under a memory cap far below raw's size → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    const columns = "machine, harness, path, generation, byte_offset, content_hash, ts, type, role, message_id, output_tokens, raw";
    // 2000 Claude lines, one message each, 100 KB of raw apiece.
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (${columns}) SELECT 'm', 'claude', '/s/claude.jsonl', 'g1', number,
      hex(SHA256(toString(number))), toDateTime64('2026-11-18 00:00:00', 3, 'UTC') + number, 'assistant', 'assistant',
      concat('msg', toString(number)), 1, ${PAD} FROM numbers(2000) SETTINGS max_block_size=100, min_insert_block_size_rows=100`);
    // 1000 Codex token_count lines with distinct cumulative totals (each credited), also 100 KB of raw apiece.
    await ch.client.exec(`INSERT INTO tokenlayer.session_events (${columns}) SELECT 'm', 'codex', '/s/codex.jsonl', 'g1', number,
      hex(SHA256(concat('c', toString(number)))), toDateTime64('2026-11-18 00:00:00', 3, 'UTC') + number, 'event_msg', 'token_count', '', 1,
      concat('{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":', toString(number), '}}},"pad":"', ${PAD}, '"}')
      FROM numbers(1000) SETTINGS max_block_size=100, min_insert_block_size_rows=100`);
  }, 60000);
  afterAll(async () => { await ch?.stop(); });

  test("the 1-day token sum from v_session_events_context", async () => {
    expect(await ch.client.queryJSON(`SELECT harness, sum(output_tokens) AS tokens FROM tokenlayer.v_session_events_context
      WHERE ts >= '2026-11-18 00:00:00' AND ts < '2026-11-19 00:00:00' GROUP BY harness ORDER BY harness ${CAP}`))
      .toEqual([{ harness: "claude", tokens: 2000 }, { harness: "codex", tokens: 1000 }]);
  }, 30000);

  test("v_provider_usage_compare", async () => {
    expect(await ch.client.queryJSON(`SELECT provider, tokens FROM tokenlayer.v_provider_usage_compare
      WHERE day = '2026-11-18' AND provider IN ('claude', 'codex') ORDER BY provider ${CAP}`))
      .toEqual([{ provider: "claude", tokens: 2000 }, { provider: "codex", tokens: 1000 }]);
  }, 30000);

  test("with optimize_read_in_window_order the stream windows read in table order, without a whole-table sort", async () => {
    const plan = await ch.client.exec(`EXPLAIN SELECT sum(output_tokens) FROM tokenlayer.v_session_events_context
      WHERE ts >= '2026-11-18 00:00:00' SETTINGS optimize_read_in_window_order=1`);
    expect(plan).toContain("Read type: InOrder");
  }, 30000);
});
