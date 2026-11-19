import { expect, test } from "bun:test";
import { applySchema } from "../../src/lib/schema";
import { startLocalClickHouse } from "../../src/lib/local-clickhouse";
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
    const planner = { type: "PLANNER_RESPONSE", session_id: "a1", input_tokens: 100, output_tokens: 10 };
    await ch.client.insert("session_events", [
      row(agyCli, "antigravity", "2026-11-19 10:00:00.000", planner),
      // The same line shipped again under a new generation counts once.
      row(agyCli, "antigravity", "2026-11-19 10:00:00.000", { ...planner, generation: "g2", ingested_at: "2026-11-19 11:30:00.000" }),
      row(agyCli, "antigravity", "2026-11-19 10:00:01.000", { type: "USER_INPUT", session_id: "a1" }),
      row(agyT3, "t3", "2026-11-15 10:00:00.000", { ...planner, session_id: "t1", input_tokens: 7, output_tokens: 3 }),
      row(codex, "t3", "2026-11-19 09:00:00.000", { type: "event_msg", role: "token_count", input_tokens: 30, output_tokens: 5 }),
      row(codex, "t3", "2026-11-14 09:00:00.000", { type: "event_msg", role: "token_count", input_tokens: 300, output_tokens: 50 }),
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
