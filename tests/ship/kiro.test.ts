import { expect, test } from "bun:test";
import { parseKiro, kiroSession } from "../../src/ship/kiro";
import { sanitizeOutput } from "../../src/lib/egress";
import { newFileState } from "../../src/ship/parse";

test("Kiro only credits identified usage summaries with finite nonnegative credit units", () => {
  const state = newFileState("kiro", "kiro", 0);
  for (const usage of [-1, "0.25", null]) {
    const raw = JSON.stringify({ payload: { type: "usage_summary", turnId: "t", promptTurnSummaries: [{ unit: "credit", usage }] } });
    expect(parseKiro(raw, state).credits).toBeNull();
    expect(parseKiro(raw, state).raw).toBe(raw);
  }
  for (const payload of [{ type: "session_metadata", value: { usagePercentage: 20 } },
    { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", usage: 1 }] },
    { type: "usage_summary", turnId: "t", promptTurnSummaries: [{ unit: "token", usage: 10 }] }]) {
    expect(parseKiro(JSON.stringify({ payload }), state).credits).toBeNull();
  }
  expect(parseKiro('{invalid', state).credits).toBeNull();
  expect(kiroSession("/sessions", "/sessions/workspace/sess-native/messages.jsonl")).toBe("sess-native");
  expect(kiroSession("/sessions", "/sessions/index.jsonl")).toBe("");
});


test("Kiro archives content like Claude/Codex while diagnostics redact synthetic secrets", () => {
  const state = newFileState("kiro", "kiro", 0);
  for (const type of ["user", "assistant", "agent_note", "tool_result"]) {
    const raw = JSON.stringify({ payload: { type, content: "Authorization: Bearer SYNTHETICarchiveToken0123456789" } });
    expect(parseKiro(raw, state).raw).toBe(raw);
    expect(sanitizeOutput(raw)).not.toContain("SYNTHETICarchiveToken0123456789");
  }
});
