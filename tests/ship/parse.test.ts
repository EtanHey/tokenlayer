import { describe, expect, test } from "bun:test";
import { detectHarness, newFileState, parseLine, projectFromCwd } from "../../src/ship/parse";

const claudeUser = JSON.stringify({
  type: "user",
  sessionId: "s-1",
  cwd: "/Users/u/Gits/golems/.worktrees/feat-x",
  entrypoint: "cli",
  timestamp: "2026-10-28T08:00:00.000Z",
  message: { role: "user", content: "hi" },
});
const claudeAssistant = (part: number) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "s-1",
    cwd: "/Users/u/Gits/golems/.worktrees/feat-x",
    entrypoint: "cli",
    timestamp: `2026-10-28T08:00:0${part}.000Z`,
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 20244,
        cache_read_input_tokens: 27549,
        output_tokens: 217,
        output_tokens_details: { thinking_tokens: 48 },
      },
    },
  });

const codexMeta = (originator: string) =>
  JSON.stringify({
    timestamp: "2026-10-28T08:29:06.147Z",
    type: "session_meta",
    payload: { id: "c-1", session_id: "c-1", cwd: "/Users/u/.t3/worktrees/brainlayer/t3-abc", originator, source: "vscode" },
  });
const codexTurn = JSON.stringify({
  timestamp: "2026-10-28T08:29:07.000Z",
  type: "turn_context",
  payload: { cwd: "/Users/u/.t3/worktrees/brainlayer/t3-abc", model: "gpt-5.5" },
});
const codexTokens = JSON.stringify({
  timestamp: "2026-10-28T08:30:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 99999, cached_input_tokens: 1, output_tokens: 9 },
      last_token_usage: {
        input_tokens: 35138,
        cached_input_tokens: 27520,
        cache_write_input_tokens: 10,
        output_tokens: 230,
        reasoning_output_tokens: 7,
      },
    },
  },
});
const codexUsageRecord = JSON.stringify({
  timestamp: "2026-10-28T08:30:00.001Z",
  type: "token_usage_record",
  payload: { response_id: "resp_1", usage: { input_tokens: 35138, cached_input_tokens: 27520, output_tokens: 230 } },
});
const codexMessage = JSON.stringify({
  timestamp: "2026-10-28T08:30:01.000Z",
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [] },
});

describe("detectHarness", () => {
  test("claude files: entrypoint sdk-ts means T3, cli means claude, none yet means undecided", () => {
    expect(detectHarness("claude", [claudeUser])).toBe("claude");
    expect(detectHarness("claude", [JSON.stringify({ type: "queue-operation" }), claudeUser.replace('"cli"', '"sdk-ts"')])).toBe("t3");
    expect(detectHarness("claude", [JSON.stringify({ type: "queue-operation" })])).toBeNull();
  });
  test("codex files: session_meta originator 'T3 Code' means T3", () => {
    expect(detectHarness("codex", [codexMeta("T3 Code")])).toBe("t3");
    expect(detectHarness("codex", [codexMeta("codex_exec")])).toBe("codex");
    expect(detectHarness("codex", [codexTurn])).toBeNull();
  });
});

describe("projectFromCwd", () => {
  test("worktrees map to their repo", () => {
    expect(projectFromCwd("/Users/u/Gits/golems/.worktrees/feat-x")).toBe("golems");
    expect(projectFromCwd("/Users/u/.t3/worktrees/brainlayer/t3-abc")).toBe("brainlayer");
    expect(projectFromCwd("/Users/u/Gits/orchestrator")).toBe("orchestrator");
    expect(projectFromCwd("")).toBe("");
  });
});

describe("parseLine (claude)", () => {
  test("extracts columns and credits usage once per message id", () => {
    const st = newFileState("claude", "claude", 0);
    const u = parseLine(claudeUser, st);
    expect(u).toMatchObject({ ts: "2026-10-28 08:00:00.000", session_id: "s-1", project: "golems", type: "user", role: "user" });
    const a1 = parseLine(claudeAssistant(1), st);
    expect(a1).toMatchObject({
      model: "claude-opus-5-5",
      role: "assistant",
      message_id: "msg_1",
      input_tokens: 2,
      cache_read_tokens: 27549,
      cache_creation_tokens: 20244,
      output_tokens: 217,
      reasoning_tokens: 48,
    });
    const a2 = parseLine(claudeAssistant(2), st);
    expect(a2.message_id).toBe("msg_1");
    expect(a2.output_tokens).toBe(0);
    expect(a2.cache_read_tokens).toBe(0);
  });

  test("lines without a timestamp inherit the previous one; invalid JSON is kept raw", () => {
    const st = newFileState("claude", "claude", Date.UTC(2026, 0, 1));
    expect(parseLine(JSON.stringify({ type: "atis-latch", sessionId: "s-1" }), st).ts).toBe("2026-01-01 00:00:00.000");
    parseLine(claudeUser, st);
    expect(parseLine(JSON.stringify({ type: "atis-latch" }), st).ts).toBe("2026-10-28 08:00:00.000");
    const bad = parseLine("{not json", st);
    expect(bad.type).toBe("invalid");
    expect(bad.raw).toBe("{not json");
  });
});

describe("parseLine (codex)", () => {
  test("session/cwd/model carry forward from session_meta and turn_context", () => {
    const st = newFileState("codex", "t3", 0);
    expect(parseLine(codexMeta("T3 Code"), st)).toMatchObject({ session_id: "c-1", project: "brainlayer", type: "session_meta" });
    parseLine(codexTurn, st);
    const m = parseLine(codexMessage, st);
    expect(m).toMatchObject({ session_id: "c-1", model: "gpt-5.5", type: "response_item", role: "assistant" });
  });

  test("tokens come from token_count.last_token_usage only (uncached input), never the duplicate usage record", () => {
    const st = newFileState("codex", "codex", 0);
    parseLine(codexMeta("codex_exec"), st);
    const t = parseLine(codexTokens, st);
    expect(t).toMatchObject({
      type: "event_msg",
      role: "token_count",
      input_tokens: 35138 - 27520,
      cache_read_tokens: 27520,
      cache_creation_tokens: 10,
      output_tokens: 230,
      reasoning_tokens: 7,
    });
    const r = parseLine(codexUsageRecord, st);
    expect(r.output_tokens).toBe(0);
    expect(r.message_id).toBe("resp_1");
  });

  test("a repeated token_count (same running total, e.g. a rate-limit refresh) is not credited twice", () => {
    const st = newFileState("codex", "codex", 0);
    expect(parseLine(codexTokens, st).output_tokens).toBe(230);
    expect(parseLine(codexTokens, st).output_tokens).toBe(0);
  });
});
