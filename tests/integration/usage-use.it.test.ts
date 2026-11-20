import { expect } from "bun:test";
import { test } from "../support/clickhouse-gate";
import { applySchema } from "../../src/lib/schema";
import { startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { parseLine } from "../../src/ship/parse";
import { readUse } from "../../src/usage/use";

// Fixture rows shaped like the live store on 2026-11-19 (paths, types, roles); values invented.
test("counted use dedupes replays and revisions, keeps the 24 h and 7 d windows apart, and ignores Claude", async () => {
  const ch = await startLocalClickHouse();
  try {
    await applySchema(ch.client);
    const row = (path: string, harness: string, ts: string, extra: Record<string, unknown> = {}) => ({
      machine: "m4", harness, path, generation: "g1", byte_offset: 0, content_hash: `${path}@${ts}`, line_bytes: 1, ts,
      session_id: "", session_alias: "", project: "", cwd: "", type: "", role: "", model: "", message_id: "",
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, credits: null, raw: "{}",
      ingested_at: "2026-11-19 11:00:00.000", ...extra });
    const agyCli = "/home/fixture/.gemini/antigravity-cli/brain/a1/steps.jsonl", agyT3 = "/home/fixture/.t3/userdata/providers/antigravity/t1.jsonl";
    const codex = "/home/fixture/.codex/sessions/2026/11/19/rollout-c1.jsonl", kiro = "/home/fixture/.kiro/sessions/k/sess_k1";
    const codexInfo = (input: number, output: number) => ({ raw: JSON.stringify({ payload: { info: {
      total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: input, output_tokens: output }
    } } }) });
    const planner = { type: "PLANNER_RESPONSE", session_id: "a1", input_tokens: 100, output_tokens: 10 };
    await ch.client.insert("session_events", [
      row(agyCli, "antigravity", "2026-11-19 10:00:00.000", planner),
      // The same line shipped again under a new generation counts once.
      row(agyCli, "antigravity", "2026-11-19 10:00:00.000", { ...planner, generation: "g2", ingested_at: "2026-11-19 11:30:00.000" }),
      row(agyCli, "antigravity", "2026-11-19 10:00:01.000", { type: "USER_INPUT", session_id: "a1" }),
      row(agyT3, "t3", "2026-11-15 10:00:00.000", { ...planner, session_id: "t1", input_tokens: 7, output_tokens: 3 }),
      row(codex, "t3", "2026-11-19 09:00:00.000", { type: "event_msg", role: "token_count", input_tokens: 30, output_tokens: 5, ...codexInfo(30, 5) }),
      row(codex, "t3", "2026-11-14 09:00:00.000", { type: "event_msg", role: "token_count", input_tokens: 300, output_tokens: 50, ...codexInfo(300, 50) }),
      row(codex, "t3", "2026-11-10 09:00:00.000", { type: "event_msg", role: "token_count", input_tokens: 9999, output_tokens: 9999 }),
      row(codex, "t3", "2026-11-19 09:00:01.000", { type: "response_item", role: "assistant", session_id: "c1" }),
      row(kiro, "kiro", "2026-11-18 14:40:00.000", { type: "kiro:assistant", role: "assistant", session_id: "k1" }),
      row(kiro, "kiro", "2026-11-18 14:41:00.000", { type: "kiro:usage_summary", session_id: "k1", message_id: "turn-1", credits: 0.125 }),
      // A later revision of the same Kiro turn replaces its credits; it never adds.
      row(kiro, "kiro", "2026-11-18 14:41:00.000", { type: "kiro:usage_summary", session_id: "k1", message_id: "turn-1", credits: 0.25,
        generation: "g2", content_hash: "rev2", ingested_at: "2026-11-19 11:30:00.000" }),
      row(kiro, "kiro", "2026-11-12 14:41:00.000", { type: "kiro:usage_summary", session_id: "k0", message_id: "turn-0", credits: 1 }),
      row("/home/fixture/.claude/projects/p/s.jsonl", "claude", "2026-11-19 10:00:00.000", { type: "assistant", role: "assistant", input_tokens: 5, output_tokens: 5 }),
    ]);
    const { url, user, password } = ch.client.config;
    const now = Date.parse("2026-11-19T12:00:00Z"), observed_at = "2026-11-19T12:00:00.000Z", source = "clickhouse:session_events";
    expect(await readUse(now, { CLICKHOUSE_URL: url, CLICKHOUSE_USER: user, CLICKHOUSE_PASSWORD: password })).toEqual({
      antigravity: { observed_at, source, "24h": { sessions: 1, requests: 1, input_tokens: 100, output_tokens: 10, credits: null },
        "7d": { sessions: 2, requests: 2, input_tokens: 107, output_tokens: 13, credits: null } },
      kiro: { observed_at, source, "24h": { sessions: 1, requests: 1, input_tokens: null, output_tokens: null, credits: 0.25 },
        "7d": { sessions: 1, requests: 1, input_tokens: null, output_tokens: null, credits: 1.25 } },
      codex: { observed_at, source, "24h": { sessions: 1, requests: 1, input_tokens: 30, output_tokens: 5, credits: null },
        "7d": { sessions: 1, requests: 2, input_tokens: 330, output_tokens: 55, credits: null } },
    });
  } finally { await ch.stop(); }
}, 40000);

// parseLine deliberately retains line-local tokens on refreshes; crediting belongs to the reader.
test("Codex refreshes do not count as responses, including repeats across both window boundaries", async () => {
  const ch = await startLocalClickHouse();
  try {
    await applySchema(ch.client);
    const clock = 1_800_000_000_000, day = 86_400_000;
    const path = "/home/fixture/.codex/sessions/rollout-refresh.jsonl";
    const total = (n: number) => ({ input_tokens: n, output_tokens: n / 10, total_tokens: n + n / 10 });
    const last = total(100);
    const event = (offset: number, n: number | null, index: number, extra: Record<string, unknown> = {}) => {
      const raw = JSON.stringify({ timestamp: new Date(clock + offset).toISOString(), type: "event_msg", payload: {
        type: "token_count", info: n === null ? null : { total_token_usage: index === 6 ? Object.fromEntries(Object.entries(total(n)).reverse()) : total(n), last_token_usage: last },
        rate_limits: { primary: { used_percent: index } }
      } });
      return { machine: "fixture", harness: "t3", path, generation: "g1", byte_offset: index * 1000,
        content_hash: `line-${index}`, line_bytes: raw.length, ingested_at: new Date(clock + 3_600_000).toISOString().replace("T", " ").replace("Z", ""), ...parseLine(raw), ...extra };
    };
    await ch.client.insert("session_events", [
      event(-8 * day, 100, 1), // First observation is outside seven days.
      event(-7 * day, 100, 2), // At the inclusive seven-day cut: still a refresh.
      event(-2 * day, 200, 3),
      event(-day, 200, 4), // At the inclusive 24h cut: still a refresh.
      event(-3000, 300, 5), // The one new response in 24h.
      event(-2000, 300, 6), // Different timestamp/hash/rate_limits, same cumulative usage.
      event(-1000, null, 7), // Rate-limit-only refresh.
      event(-3000, 300, 5, { generation: "g2", ingested_at: new Date(clock + 3_660_000).toISOString().replace("T", " ").replace("Z", "") }),
      event(-500, 300, 8, { machine: "other" }), // Same path/total on another machine is independent.
      event(-500, 400, 9, { path: "/home/fixture/projects/antigravity/.codex-other/rollout.jsonl" }),
      event(-500, 400, 10, { path: "/home/fixture/.codex-other/sessions/rollout.jsonl" }),
    ]);
    const { url, user, password } = ch.client.config;
    const use = await readUse(clock, { CLICKHOUSE_URL: url, CLICKHOUSE_USER: user, CLICKHOUSE_PASSWORD: password });
    expect(use.codex).toMatchObject({
      "24h": { sessions: 2, requests: 2, input_tokens: 200, output_tokens: 20 },
      "7d": { sessions: 2, requests: 3, input_tokens: 300, output_tokens: 30 },
    });
    expect(use.antigravity!["7d"]).toMatchObject({ sessions: 0, requests: 0, input_tokens: 0, output_tokens: 0 });
  } finally { await ch.stop(); }
}, 40000);
