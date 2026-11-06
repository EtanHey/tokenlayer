import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { projectGeminiJson } from "../../src/metadata/gemini-json";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
test("original UTF8 spans, immutable input, exact counter lexemes and privacy", () => {
  const message = '{"id":"same","type":"info","content":"CANARY 🦊 \\\" }","tokens":{"input":9007199254740993,"output":0,"cached":null,"thoughts":1.00000000000000001,"total":7}}';
  const raw = Buffer.from('{"sessionId":"s","projectHash":"p","body":"é","messages":[\r\n' + message + ',' + message + ']}');
  const copy = Buffer.from(raw), result = projectGeminiJson(raw);
  expect(raw.equals(copy)).toBe(true);
  expect(result.documentHash).toBe(sha(raw));
  for (const [i, row] of result.messages.entries()) {
    const start = raw.indexOf(Buffer.from(message), i ? raw.indexOf(Buffer.from(message)) + 1 : 0);
    expect(row.jsonPointer).toBe(`/messages/${i}`);
    expect(row.utf8ByteStart).toBe(start);
    expect(row.utf8ByteEndExclusive).toBe(start + Buffer.byteLength(message));
    expect(row.spanSha256).toBe(sha(message));
    expect(row.nativeGeminiTokens.fields.input.presence).toBe("UNRESOLVED");
    expect(row.nativeGeminiTokens.fields.thoughts.presence).toBe("UNRESOLVED");
    expect(row.nativeGeminiTokens.fields.output.presence).toBe("zero");
    expect(row.nativeGeminiTokens.fields.cached.presence).toBe("null");
    expect(row.nativeGeminiTokens.fields.tool.presence).toBe("absent");
  }
  expect(JSON.stringify(result)).not.toContain("CANARY");
});

import * as fs from "node:fs";
import { spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_LIMITS, geminiStatPin, readGeminiJson } from "../../src/metadata/gemini-json";
const doc = (messages: unknown[] = []) => Buffer.from(JSON.stringify({ sessionId: "s", messages }));
const error = (raw: Buffer | string, label: string, limits = {}) => expect(() => projectGeminiJson(Buffer.from(raw), limits)).toThrow(`GEMINI_${label}`);
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gemini-synthetic-"))), path = join(dir, "input.json"), raw = doc([{ id: "s" }]);
  fs.writeFileSync(path, raw);
  const pin = { documentBytes: raw.length, documentHash: sha(raw), stat: geminiStatPin(fs.lstatSync(path, { bigint: true })) };
  return { path, pin, raw, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test("pretty/minified/CRLF/terminal framing and escaped keys use independent byte search oracle", () => {
  for (const gap of ["", "\n  ", "\r\n  "]) for (const terminal of ["", "\n"]) {
    const parts = ['{"id":"a","content":{"a~/🦊":"}\\\"{"}}', '{"id":"a","type":"user"}'];
    const raw = Buffer.from('{"prefix":"é🦊","messa\\u0067es":[' + gap + parts.join(',' + gap) + gap + ']}' + terminal);
    const result = projectGeminiJson(raw); let cursor = 0;
    expect(result.documentBytes).toBe(raw.length); expect(result.documentHash).toBe(sha(raw));
    for (const [i, part] of parts.entries()) {
      const start = raw.indexOf(Buffer.from(part), cursor), end = start + Buffer.byteLength(part); cursor = end;
      expect(result.messages[i]).toMatchObject({ jsonPointer: `/messages/${i}`, utf8ByteStart: start, utf8ByteEndExclusive: end, spanBytes: end - start, spanSha256: sha(part) });
    }
    expect(result.messages[1].model.presence).toBe("absent");
  }
});
test("all elements are accounted for; independent clocks, info and metadata presence", () => {
  const r = projectGeminiJson(Buffer.from('{"sessionId":null,"startTime":"2030-02-30T00:00:00Z","lastUpdated":0,"messages":[null,[],7,{"type":"info","timestamp":"2030-01-01T00:00:00Z","model":"m"},{"timestamp":null},{}]}'));
  expect(r.messages.map(x => x.jsonPointer)).toEqual([0,1,2,3,4,5].map(x => `/messages/${x}`));
  expect(r.messages.slice(0,3).every(x => x.status === "UNSUPPORTED_ELEMENT")).toBe(true);
  expect(r.nativeSessionId.presence).toBe("null"); expect(r.nativeProjectHash.presence).toBe("absent");
  expect(r.startTime.presence).toBe("UNRESOLVED"); expect(r.lastUpdated.presence).toBe("UNRESOLVED");
  expect(r.messages[3].type.value).toBe("info"); expect(r.messages[3].timestamp.value).toBe("2030-01-01T00:00:00Z");
  expect(r.messages[4].timestamp.presence).toBe("null"); expect(r.messages[5].timestamp.presence).toBe("absent");
  expect(r.messages[4].model.presence).toBe("absent");
});
test("fixed diagnostics reject invalid UTF8, all invalid grammar/root shapes and decoded duplicates", () => {
  error(Buffer.from([123,34,120,34,58,34,255,34,125]), "UTF8_INVALID");
  for (const s of ['', '{}x', '{"messages":[],}', '{"messages":[1,]}', '{"messages":[01]}', '{"messages":["\\x"]}', '{"messages":[true false]}', '{"messages":["\n"]}']) error(s, "JSON_INVALID");
  for (const s of ['null', '[]', '{}', '{"messages":{}}']) error(s, "ROOT_INVALID");
  for (const s of ['{"messages":[],"messa\\u0067es":[]}', '{"sessionId":1,"session\\u0049d":2,"messages":[]}', '{"messages":[{"id":1,"\\u0069d":2}]}', '{"messages":[{"tokens":{"input":0,"in\\u0070ut":1}}]}', '{"messages":[{"content":{"a~/":1,"a~/":2}}]}']) error(s, "DUPLICATE_KEY");
});
test("every counter preserves presence and exact integer semantics, never body names or values", () => {
  for (const key of ["input", "output", "cached", "thoughts", "tool", "total"]) {
    for (const [lexeme, presence, value] of [['null','null',null], ['0','zero',0], ['7','value',7], ['1.20e1','value',12], ['9007199254740991','value',9007199254740991], ['1.00000000000000001','UNRESOLVED',undefined], ['9007199254740993','UNRESOLVED',undefined], ['1e9999','UNRESOLVED',undefined], ['-1','UNRESOLVED',undefined], ['1.5','UNRESOLVED',undefined], ['"CANARY_VALUE"','UNRESOLVED',undefined], ['{"CANARY_KEY":"CANARY_VALUE"}','UNRESOLVED',undefined]] as const) {
      const r = projectGeminiJson(Buffer.from(`{"messages":[{"tokens":{"${key}":${lexeme},"CANARY_KEY":{"x":"CANARY_VALUE"}},"thoughts":["CANARY_THOUGHT"],"toolCalls":["CANARY_TOOL"]}]}`));
      expect(r.messages[0].nativeGeminiTokens.fields[key as "input"]).toMatchObject({ presence });
      expect(r.messages[0].nativeGeminiTokens.fields[key as "input"].value).toBe(value);
      expect(r.messages[0].nativeGeminiTokens.fields[key as "input"].sourceSha256).toBe(sha(lexeme));
      expect(r.messages[0].nativeGeminiTokens.unknownKeyCount).toBe(1); expect(JSON.stringify(r)).not.toContain("CANARY");
    }
  }
  for (const [tokens, presence] of [[undefined,'absent'], [null,'null'], ['CANARY','UNRESOLVED'], [7,'UNRESOLVED']] as const)
    expect(projectGeminiJson(doc([{tokens}])).messages[0].nativeGeminiTokens.presence).toBe(presence);
});
test("hard byte/depth/token/message bounds and deterministic elapsed deadline", () => {
  error(Buffer.alloc(GEMINI_LIMITS.bytes + 1, 32), "BYTE_LIMIT");
  error('{"messages":[],"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}', "DEPTH_LIMIT");
  error('{"messages":[],"x":[' + '0,'.repeat(100000) + '0]}', "TOKEN_LIMIT");
  error(doc(Array(10001).fill(null)), "MESSAGE_LIMIT"); error(doc(), "TOKEN_LIMIT", { tokens: 1 });
  error(doc(), "LIMIT_CONFIG", { bytes: GEMINI_LIMITS.bytes + 1 });
  const clock = spyOn(performance, "now"); let n = 0; clock.mockImplementation(() => n++ * 2000);
  try { error(doc(), "TIME_LIMIT"); } finally { clock.mockRestore(); }
});
test("exact pinned file, short reads, hash/size/stat mismatch and path guards", () => {
  const f = fixture(); const original = fs.readSync;
  try {
    const reads = spyOn(fs, "readSync").mockImplementation(((fd: number, b: Buffer, at: number, length: number, pos: null) => original(fd, b, at, Math.min(length, 3), pos)) as typeof fs.readSync);
    try { expect(readGeminiJson(f.path, f.pin).documentHash).toBe(sha(f.raw)); expect(reads.mock.calls.length).toBeGreaterThan(2); } finally { reads.mockRestore(); }
    expect(() => readGeminiJson(f.path, {...f.pin, documentHash:"a".repeat(64)})).toThrow("GEMINI_HASH_PIN");
    expect(() => readGeminiJson(f.path, {...f.pin, documentBytes:f.raw.length+1})).toThrow("GEMINI_SIZE_PIN");
    expect(() => readGeminiJson(f.path, {...f.pin, stat:{...f.pin.stat,ino:"0"}})).toThrow("GEMINI_STAT_PIN");
    fs.symlinkSync(f.path,f.path+"link"); expect(() => readGeminiJson(f.path+"link",f.pin)).toThrow("GEMINI_PATH_INVALID");
    expect(() => readGeminiJson(f.path+"/..",f.pin)).toThrow("GEMINI_PATH_INVALID");
    expect(() => readGeminiJson(f.path.slice(0,f.path.lastIndexOf('/')),f.pin)).toThrow("GEMINI_FILE_INVALID");
  } finally { f.cleanup(); }
});
test("latched replacement, growth, same-size mutation, symlink swap and truncation cannot return metadata", () => {
  for (const mode of ["replace","grow","mutate","symlink","truncate"] as const) {
    const f = fixture(), original = fs.readSync; let once = false;
    const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const n = original(...args);
      if (!once) { once = true;
        if (mode === "grow") fs.appendFileSync(f.path, " ");
        if (mode === "mutate") fs.writeFileSync(f.path, Buffer.alloc(f.raw.length,32));
        if (mode === "truncate") fs.truncateSync(f.path,0);
        if (mode === "replace" || mode === "symlink") { fs.renameSync(f.path,f.path+"saved"); if(mode === "replace") fs.writeFileSync(f.path,f.raw); else fs.symlinkSync(f.path+"saved",f.path); }
      } return n;
    }) as typeof fs.readSync);
    try { expect(() => readGeminiJson(f.path,f.pin)).toThrow(mode === "grow" ? "GEMINI_FILE_GROWTH" : "GEMINI_STAT_PIN"); }
    finally { reads.mockRestore(); f.cleanup(); }
  }
});
test("before-open and after-projection identity latches refuse changes; fixed IO diagnostics", () => {
  for (const phase of ["open","final"] as const) {
    const f=fixture(); let calls=0;
    const original=fs.fstatSync, stats=spyOn(fs,"fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>)=>{
      if(++calls===(phase==="open"?1:3)) fs.appendFileSync(f.path," ");
      return original(...args);
    }) as typeof fs.fstatSync);
    try { expect(()=>readGeminiJson(f.path,f.pin)).toThrow("GEMINI_STAT_PIN"); }
    finally {stats.mockRestore();f.cleanup();}
  }
  const f=fixture(); try {
    expect(()=>readGeminiJson(f.path+"CANARY_MISSING",f.pin)).toThrow("GEMINI_IO_FAILURE");
    const reader=spyOn(fs,"readSync").mockImplementation(()=>0);
    try {expect(()=>readGeminiJson(f.path,f.pin)).toThrow("GEMINI_SHORT_FILE");} finally {reader.mockRestore();}
    const r=projectGeminiJson(doc([{tokens:{input:1,CANARY_KEY:2}}]));
    expect(r.messages[0].nativeGeminiTokens.presence).toBe("UNRESOLVED");
    expect(r.messages[0].arrayIndex).toBe(0);expect(r.messages[0].outputOrdinal).toBe(1);
    expect(r.nativeSessionId.jsonPointer).toBe("/sessionId");
  } finally {f.cleanup();}
});
test("clock lexemes retain zone/fraction without Date precision loss or calendar rollover",()=>{
  for(const timestamp of ["2032-02-29T23:59:59.123456789+02:30","2030-01-01T00:00:00-00:00","2030-01-01T00:00:00Z"])
    expect(projectGeminiJson(doc([{timestamp}])).messages[0].timestamp).toMatchObject({presence:"value",value:timestamp});
  for(const timestamp of ["2030-02-29T00:00:00Z","2030-13-01T00:00:00Z","2030-01-01T24:00:00Z","2030-01-01T00:00:00+24:00","CANARY_TIME",true,{},""])
    expect(projectGeminiJson(doc([{timestamp}])).messages[0].timestamp.presence).toBe("UNRESOLVED");
});

function reviewFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'review-a-synthetic-')));
  const parent = join(dir, 'parent'); fs.mkdirSync(parent);
  const path = join(parent, 'input.json'), raw = Buffer.from('{"sessionId":"synthetic","messages":[{}]}');
  fs.writeFileSync(path, raw);
  return { dir, parent, path, raw, pin: { documentBytes: raw.length, documentHash: sha(raw), stat: geminiStatPin(fs.lstatSync(path, { bigint: true })) },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('MUST: final canonical path recheck rejects a newly symlinked ancestor', () => {
  const f = reviewFixture(), original = fs.fstatSync; let calls = 0;
  const stats = spyOn(fs,'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    if (++calls === 3) { fs.renameSync(f.parent,f.parent+'-moved'); fs.symlinkSync(f.parent+'-moved',f.parent); }
    return original(...args);
  }) as typeof fs.fstatSync);
  try { expect(() => readGeminiJson(f.path,f.pin)).toThrow('GEMINI_PATH_INVALID'); }
  finally {stats.mockRestore();f.cleanup();}
});
test('control: ancestor substitution before the existing canonical recheck is rejected', () => {
  const f = reviewFixture(), original = fs.fstatSync; let calls = 0;
  const stats = spyOn(fs,'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    if (++calls === 2) { fs.renameSync(f.parent,f.parent+'-moved'); fs.symlinkSync(f.parent+'-moved',f.parent); }
    return original(...args);
  }) as typeof fs.fstatSync);
  try { expect(() => readGeminiJson(f.path,f.pin)).toThrow('GEMINI_PATH_INVALID'); }
  finally {stats.mockRestore();f.cleanup();}
});
test('MUST: pure projection checks deadline after projecting root fields', () => {
  const original = JSON.parse; let now = 0, ownerParses = 0;
  const clock = spyOn(performance,'now').mockImplementation(() => now);
  const parse = spyOn(JSON,'parse').mockImplementation(((...args: Parameters<typeof JSON.parse>) => {
    const result = original(...args);
    if (args[0] === '"REVIEW_A_OWNER"' && ++ownerParses === 2) now = 2000;
    return result;
  }) as typeof JSON.parse);
  try { expect(() => projectGeminiJson(Buffer.from('{"sessionId":"REVIEW_A_OWNER","messages":[]}'))).toThrow('GEMINI_TIME_LIMIT'); }
  finally {parse.mockRestore();clock.mockRestore();}
});
test('control: expiration during message projection is caught by the existing final check', () => {
  const original = JSON.parse; let now = 0, parses = 0;
  const clock = spyOn(performance,'now').mockImplementation(() => now);
  const parse = spyOn(JSON,'parse').mockImplementation(((...args: Parameters<typeof JSON.parse>) => {
    const result = original(...args);
    if (args[0] === '"REVIEW_A_MESSAGE"' && ++parses === 2) now = 2000;
    return result;
  }) as typeof JSON.parse);
  try { expect(() => projectGeminiJson(Buffer.from('{"messages":[{"id":"REVIEW_A_MESSAGE"}]}'))).toThrow('GEMINI_TIME_LIMIT'); }
  finally {parse.mockRestore();clock.mockRestore();}
});
