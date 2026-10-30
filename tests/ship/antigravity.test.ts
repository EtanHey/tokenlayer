import { expect, test } from "bun:test";
import { antigravitySession, parseAntigravity } from "../../src/ship/antigravity";
import { detectHarness, newFileState } from "../../src/ship/parse";
import { sanitizeOutput } from "../../src/lib/egress";

test("Antigravity roots decide harness without reading message text; reject unrelated JSONL", () => {
  expect(detectHarness("antigravity-cli", [])).toBe("antigravity");
  expect(detectHarness("t3-antigravity", [])).toBe("t3");
  expect(antigravitySession("/brain", "/brain/native/.system_generated/logs/transcript.jsonl", "antigravity-cli")).toBe("native");
  expect(antigravitySession("/brain", "/brain/copied.jsonl", "antigravity-cli")).toBe("");
});

test("Antigravity fails closed without an initial timestamp; preserves raw and egress hygiene", () => {
  const state = newFileState("antigravity-cli", "antigravity", 0);
  expect(() => parseAntigravity('{}', state)).toThrow("no preceding timestamp");
  const raw = JSON.stringify({ created_at: "2026-10-30T00:00:00Z", input_tokens: 3, cache_read_tokens: 4, output_tokens: 5, tool_calls: [{ content: "Authorization: Bearer syntheticToken0123456789abcdef" }] });
  expect(parseAntigravity(raw, state)).toMatchObject({ input_tokens: 3, cache_read_tokens: 4, output_tokens: 5, raw, model: "" });
  expect(parseAntigravity('{bad', state)).toMatchObject({ ts: "2026-10-30 00:00:00.000", type: "invalid", raw: '{bad' });
  expect(sanitizeOutput(raw)).not.toContain("syntheticToken0123456789abcdef");
});
