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

describe("parseLine secret hygiene", () => {
  test("a tool printing synthetic clickhouse.env retains credentials in raw", () => {
    const output = "CLICKHOUSE_PASSWORD=syntheticClickhousePassword&syntheticPasswordTail\nCLIPROXY_MGMT_KEY=\"syntheticManagementKey\"\n";
    const row = parseLine(JSON.stringify({
      type: "user", sessionId: "synthetic-session", timestamp: "2026-10-28T08:00:00Z",
      message: { role: "user", content: [{ type: "tool_result", content: `cat clickhouse.env\n${output}` }] },
      toolUseResult: { stdout: output, headers: JSON.stringify("before\nCookie: syntheticCookieTail\nafter") },
    }), newFileState("claude", "t3", 0));
    expect(row.raw).toContain("syntheticClickhousePassword");
    expect(row.raw).toContain("syntheticManagementKey");
    expect(row.raw).toContain("syntheticPasswordTail");
    expect(row.raw).toContain("syntheticCookieTail");
    expect(JSON.parse(row.raw).message.content[0].type).toBe("tool_result");
    expect(row.raw).toContain("clickhouse.env");
  });

  const KEY = "sk-ant-api03-FAKEfakeFAKEfake0123456789";
  const EMAIL = "frank.fake@example.invalid";
  const OAUTH = "sk-ant-oat01-FAKEfakeFAKE0123456789";
  const authFile = { type: "codex", email: EMAIL, tokens: { access_token: OAUTH, refresh_token: "opaque-refresh-fake", id_token: "opaque-id-fake" } };

  test("nested tool output with an auth file, a key and an email is retained in raw", () => {
    const st = newFileState("claude", "claude", 0);
    const line = JSON.stringify({
      ...JSON.parse(claudeUser),
      message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: `${JSON.stringify(authFile)}\nkey=${KEY}` }] }] },
      toolUseResult: { stdout: JSON.stringify(authFile, null, 2), stderr: `contact ${EMAIL}` },
    });
    const row = parseLine(line, st);
    expect(row.raw).toBe(line);
    expect(row).toMatchObject({ session_id: "s-1", project: "golems", type: "user", role: "user" });
    expect(JSON.parse(row.raw).message.content[0].type).toBe("tool_result");
  });

  test("codex function-call output and invalid lines are retained too", () => {
    const st = newFileState("codex", "codex", 0);
    const call = JSON.stringify({
      timestamp: "2026-10-28T08:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: `curl -H 'Authorization: Bearer fakeBearer0123456789abcdef' -H 'x-api-key: ${KEY}'` },
    });
    expect(parseLine(call, st).raw).toBe(call);
    const bad = parseLine(`{"oops": ${JSON.stringify(authFile)} ${EMAIL}`, st);
    expect(bad.type).toBe("invalid");
    expect(bad.raw).toBe(`{"oops": ${JSON.stringify(authFile)} ${EMAIL}`);
  });
});
