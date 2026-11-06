import { describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../../src/metadata/stream";
import { geminiStatPin } from "../../src/metadata/gemini-json";
import { projectCursorProjectJsonl, readCursorProjectJsonl } from "../../src/metadata/cursor-project-jsonl";

const line = (o: unknown) => JSON.stringify(o) + "\n";
// Observed shape only; every value below is synthetic. No real content or identifiers.
const observed = { role: "assistant", message: { content: [
  { type: "text", text: "PRIVATE BODY 🐈" },
  { type: "tool_use", name: "synthetic", input: { password: "PRIVATE INPUT" } },
] } };

describe("Cursor project JSONL metadata", () => {
  test("observed nested content is executable metadata recovery, with exact LF coordinates", () => {
    const first = line(observed).replace(/\n$/, "\r\n"), second = line({ role: "user", message: { content: [] } });
    const raw = Buffer.from(first + second), p = projectCursorProjectJsonl(raw);
    expect(p.sourceSha256).toBe(hash(raw));
    expect(p.records.map(r => [r.originalLFLine, r.utf8ByteStart, r.recordBytes, r.recordSha256]))
      .toEqual([[1, 0, Buffer.byteLength(first), hash(Buffer.from(first))], [2, Buffer.byteLength(first), Buffer.byteLength(second), hash(Buffer.from(second))]]);
    expect(p.records[0].status).toBe("PROJECTED");
    expect(p.records[0].metadata?.contentBlocks.length).toBe(2);
    expect(p.records[0].metadata?.outer.ids.sessionId.presence).toBe("absent");
    expect(p.records[0].gaps).toContain("EVENT_CLOCK_UNKNOWN");
    expect(JSON.stringify(p)).not.toMatch(/PRIVATE BODY|PRIVATE INPUT|password|🐈/);
    expect(p.complete).toBe(false);
  });
  test("recorded lineage, clocks and every counter component retain absence/null/zero without arithmetic", () => {
    const p = projectCursorProjectJsonl(Buffer.from(line({ ...observed, sessionId: "s", requestId: "req", parentId: null,
      createdAt: "2026-01-01T00:00:00Z", timestamp: 0, clientId: "client", accountId: "account",
      message: { ...observed.message, id: "response", usage: { input_tokens: 0, output_tokens: null,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 },
        extraComponent: 3, suspiciousBodyKey: "PRIVATE COUNTER", total_tokens: 9007199254740992 },
        content: [{ type: "tool_use", id: "call", parentId: "parent", input: { requestId: "DO NOT WALK" } }] } })));
    const m = p.records[0].metadata!;
    expect(m.outer.ids.requestId.value).toBe("req"); expect(m.outer.ids.parentId.presence).toBe("null");
    expect(m.message.ids.id.value).toBe("response"); expect(m.contentBlocks[0].ids.id.value).toBe("call");
    expect(m.outer.clocks.timestamp).toMatchObject({ presence: "zero", value: 0 });
    expect(m.outer.clocks.createdAt.value).toBe("2026-01-01T00:00:00Z");
    const u = m.message.usage.usage;
    expect(u.fields?.input_tokens).toMatchObject({ presence: "zero", value: 0 });
    expect(u.fields?.output_tokens.presence).toBe("null"); expect(u.fields?.cached_input_tokens.presence).toBe("absent");
    expect(u.fields?.total_tokens.presence).toBe("UNRESOLVED");
    expect(u.fields?.cache_creation.fields?.ephemeral_1h_input_tokens.value).toBe(0);
    expect(u.unknown?.map(x => x.field.value)).toContain(3);
    expect(JSON.stringify(p)).not.toMatch(/extraComponent|suspiciousBodyKey|PRIVATE COUNTER|DO NOT WALK/);
    expect(p.counterSemantics).toBe("UNKNOWN");
  });
  test("unsupported, malformed, duplicate, UTF8, oversize, and incomplete LF records are explicit gaps", () => {
    const cases: [Buffer, string][] = [[Buffer.from(line({ type: "terminal", opaque: "PRIVATE" })), "UNSUPPORTED_SHAPE"],
      [Buffer.from('{"role":"user","role":"assistant"}\n'), "INVALID_JSON"], [Buffer.from("\n"), "INVALID_JSON"],
      [Buffer.from([0xff, 10]), "INVALID_UTF8"], [Buffer.from(line(observed).trimEnd()), "UNTERMINATED_LF"]];
    for (const [raw, status] of cases) expect(projectCursorProjectJsonl(raw).records[0].status).toBe(status);
    const p = projectCursorProjectJsonl(Buffer.from(line(observed)), { lineBytes: 32 });
    expect(p.records[0].status).toBe("OVERSIZE_LINE"); expect(p.records[0].recordSha256).toBe(hash(Buffer.from(line(observed))));
    expect(() => projectCursorProjectJsonl(Buffer.from(line(observed)), { bytes: 10 })).toThrow("CURSOR_BYTE_LIMIT");
    expect(() => projectCursorProjectJsonl(Buffer.from(line(observed)), { blocks: 1 })).toThrow("CURSOR_BLOCK_LIMIT");
    expect(() => projectCursorProjectJsonl(Buffer.from(line(observed)), { outputBytes: 10 })).toThrow("CURSOR_OUTPUT_LIMIT");
    expect(() => projectCursorProjectJsonl(Buffer.from(line(observed) + line(observed)), { lines: 1 })).toThrow("CURSOR_LINE_LIMIT");
    expect(projectCursorProjectJsonl(Buffer.alloc(0)).gaps).toContain("NO_RECORDS");
    expect(projectCursorProjectJsonl(Buffer.from(line({ ...observed, message: { ...observed.message, extra: 1 } }))).records[0].gaps)
      .toContain("UNSUPPORTED_NESTED_FIELDS");
    const deep = '{"role":"user","message":{"content":[]},"body":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}\n';
    expect(projectCursorProjectJsonl(Buffer.from(deep)).records[0].status).toBe("PARSER_LIMIT");
  });
  test("unsafe metadata stays unresolved, unknown field names and tool input never escape", () => {
    const p = projectCursorProjectJsonl(Buffer.from(line({ ...observed, sessionId: "Bearer synthetic-secret", requestId: { body: "PRIVATE" },
      accountKey: "PRIVATE KEY", "PRIVATE PROPERTY": { timestamp: "DO NOT WALK" } })));
    expect(p.records[0].metadata?.outer.ids.sessionId.presence).toBe("UNRESOLVED");
    expect(p.records[0].metadata?.outer.ids.requestId.presence).toBe("UNRESOLVED");
    expect(JSON.stringify(p)).not.toMatch(/PRIVATE|synthetic-secret|accountKey|DO NOT WALK/);
    expect(p.records[0].gaps).toContain("UNSUPPORTED_METADATA");
    const lifecycle = projectCursorProjectJsonl(Buffer.from(line({ ...observed, createdAt: 123 })));
    expect(lifecycle.records[0].gaps).toContain("EVENT_CLOCK_UNKNOWN");
  });
  test("JSON number rounding cannot invent a stored zero or an exact token count", () => {
    const raw = Buffer.from('{"role":"assistant","message":{"content":[],"usage":{"input_tokens":1e-400,"output_tokens":9007199254740991.1}}}\n');
    const u = projectCursorProjectJsonl(raw).records[0].metadata!.message.usage.usage;
    expect(u.fields?.input_tokens.presence).toBe("UNRESOLVED");
    expect(u.fields?.output_tokens.presence).toBe("UNRESOLVED");
  });
  test("pinned reader verifies original bytes and stat, refuses symlinks/changed pins, never writes source", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "cursor-project-synthetic-"))), path = join(dir, "session.jsonl");
    try {
      const raw = Buffer.from(line(observed)); fs.writeFileSync(path, raw, { mode: 0o600 });
      const pin = { bytes: raw.length, sha256: hash(raw), stat: geminiStatPin(fs.lstatSync(path, { bigint: true })) };
      expect(readCursorProjectJsonl(path, pin).sourceSha256).toBe(pin.sha256);
      expect(() => readCursorProjectJsonl(path, { ...pin, sha256: "0".repeat(64) })).toThrow("CURSOR_HASH_PIN");
      expect(() => readCursorProjectJsonl(path, { ...pin, stat: { ...pin.stat, ino: "0" } })).toThrow("CURSOR_STAT_PIN");
      fs.symlinkSync(path, join(dir, "alias")); expect(() => readCursorProjectJsonl(join(dir, "alias"), pin)).toThrow("CURSOR_PATH");
      expect(fs.readFileSync(path)).toEqual(raw);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });
});

test("final hash deadline is enforced by pure projector", () => {
  let now = 0; const original = crypto.createHash;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const sha = spyOn(crypto, "createHash").mockImplementation(((...args: Parameters<typeof crypto.createHash>) => { now = 3000; return original(...args); }) as typeof crypto.createHash);
  try { expect(() => projectCursorProjectJsonl(Buffer.alloc(0))).toThrow("CURSOR_TIME_LIMIT"); } finally { sha.mockRestore(); clock.mockRestore(); }
});
test("block-only clocks and counters inform row gaps without inferring semantics", () => {
  for (const usage of [null, { input_tokens: 0 }, { input_tokens: 7 }]) {
    const p = projectCursorProjectJsonl(Buffer.from(line({ role: "assistant", message: { content: [{ timestamp: "2030-01-01T00:00:00Z", usage }] } })));
    expect(p.records[0].gaps).not.toContain("COUNTERS_ABSENT"); expect(p.records[0].gaps).not.toContain("EVENT_CLOCK_UNKNOWN"); expect(p.eventClockSemantics).toBe("RECORDED_FIELDS_ONLY_UNVERIFIED");
  }
});
