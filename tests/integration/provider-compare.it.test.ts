import { expect, test } from "bun:test";
import { applySchema } from "../../src/lib/schema";
import { startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { parseLine } from "../../src/ship/parse";

test("comparison keeps UTC-day credits separate from rolling quota gauges and deduplicates Kiro turns", async () => {
  const ch = await startLocalClickHouse();
  try {
    await applySchema(ch.client);
    const put = async (path: string, harness: string, raw: unknown, extras = {}) => ch.client.insert("session_events", [{
      ...parseLine(JSON.stringify(raw)), machine: "fixture", path, harness, generation: "g1", byte_offset: 0,
      content_hash: "v1", line_bytes: 1, ingested_at: "2026-11-03 04:00:00.000", ...extras,
    }]);
    await put("kiro/messages.jsonl", "t3", {}, { ts: "2026-11-03 03:00:00.000", session_id: "native", type: "kiro:usage_summary", message_id: "turn-1", credits: 0.125 });
    // Same native turn in a later retained revision: choose its latest value, never add both.
    await put("kiro/messages.jsonl", "t3", {}, { ts: "2026-11-03 03:00:00.000", session_id: "native", type: "kiro:usage_summary", message_id: "turn-1", credits: 0.25, generation: "g2", ingested_at: "2026-11-03 05:00:00.000" });
    await put("claude.jsonl", "t3", { timestamp: "2026-11-03T03:00:00Z", type: "assistant", sessionId: "claude", message: { id: "msg", role: "assistant", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 } } });
    await put("codex.jsonl", "t3", { timestamp: "2026-11-03T03:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 300 }, secondary: { used_percent: 30, window_minutes: 10080 } }, info: { last_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5 } } } });
    await put("agy.jsonl", "t3", { created_at: "2026-11-03T03:00:00Z" }, { ts: "2026-11-03 03:00:00.000", input_tokens: 7, output_tokens: 3 });
    await ch.client.insert("credentials_snap", [{ ts: "2026-11-03 03:00:00.000", provider: "claude", credential: "fixture", utilization_5h: 0.25, utilization_7d: 0.5 }]);
    const rows = await ch.client.queryJSON("SELECT provider, tokens, credits_used, daily_allowance_used_pct, peak_5h_used_pct, peak_weekly_used_pct, tokens_per_1pct_allowance FROM tokenlayer.v_provider_usage_compare ORDER BY provider");
    expect(rows).toEqual([
      { provider: "antigravity", tokens: 10, credits_used: null, daily_allowance_used_pct: null, peak_5h_used_pct: null, peak_weekly_used_pct: null, tokens_per_1pct_allowance: null },
      { provider: "claude", tokens: 35, credits_used: null, daily_allowance_used_pct: null, peak_5h_used_pct: 25, peak_weekly_used_pct: 50, tokens_per_1pct_allowance: null },
      { provider: "codex", tokens: 35, credits_used: null, daily_allowance_used_pct: null, peak_5h_used_pct: 12, peak_weekly_used_pct: 30, tokens_per_1pct_allowance: null },
      { provider: "kiro", tokens: null, credits_used: 0.25, daily_allowance_used_pct: 0.5, peak_5h_used_pct: null, peak_weekly_used_pct: null, tokens_per_1pct_allowance: null },
    ]);
    expect(await ch.client.queryJSON("SELECT count() AS n FROM tokenlayer.v_provider_usage_compare WHERE note = ''")).toEqual([{ n: 0 }]);
  } finally { await ch.stop(); }
}, 40000);
