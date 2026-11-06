import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as reader from "../../src/metadata/gemini-json";
import { exportGeminiJson } from "../../src/metadata/gemini-export";
import { hash } from "../../src/metadata/stream";
const PROFILE = "large-document-16mib-v1" as const, CAP = 16 * 1024 ** 2;
const head = '{"sessionId":"synthetic","prefix":"é🦊","messages":[{"id":"m","type":"gemini","content":"';
const tail = '","tokens":{"input":7,"output":0,"cached":null,"thoughts":9007199254740993,"total":1.20e1}}]}';
const body = (bytes: number) => Buffer.from(head + "BODY_CANARY" + "x".repeat(bytes - Buffer.byteLength(head + tail) - 11) + tail);
function fixture(raw: Buffer) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gemini-profile-"))), path = join(dir, "chat.json"), input = join(dir, "input.json"), out = join(dir, "out");
  fs.writeFileSync(path, raw, { mode: 0o600 });
  const spec: any = { version: 1, kind: "tokenlayer-gemini-json-export-input", scope: "synthetic-profile", expectedSessionId: "synthetic", expectedMessages: 1, maxOutputRows: 1,
    source: { path, provider: "gemini-cli", sourceFormat: "gemini-chat-json", coordinateKind: "json-utf8-span-v1", admission: "synthetic", custodyMachine: "synthetic",
      originMachine: "UNKNOWN", originProof: "UNKNOWN", originalPath: "UNKNOWN", sourceRoot: dir, rootKind: "native-gemini-cli-tmp",
      documentBytes: raw.length, documentHash: hash(raw), stat: reader.geminiStatPin(fs.lstatSync(path, { bigint: true })) } };
  const save = () => fs.writeFileSync(input, JSON.stringify(spec), { mode: 0o600 }); save();
  const cli = () => Bun.spawnSync([process.execPath, resolve("src/metadata/gemini-main.ts"), input, out]);
  return { dir, path, input, out, spec, save, cli, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test("real CLI default refusal then explicit large profile preserves original bytes, spans, counters and privacy", () => {
  const raw = body(5_112_569), f = fixture(raw);
  try {
    const refused = f.cli(); expect(refused.exitCode).toBe(1); expect(refused.stderr.toString()).toContain("GEMINI_SIZE_PIN"); expect(fs.existsSync(f.out)).toBe(false);
    f.spec.readerProfile = PROFILE; f.save(); const p = f.cli(); expect(p.exitCode).toBe(2); expect(p.stderr.toString()).toBe("");
    const receipt = JSON.parse(fs.readFileSync(join(f.out, "manifest.json"), "utf8")), bytes = fs.readFileSync(join(f.out, "metadata.ndjson")), row = JSON.parse(bytes.toString());
    expect(receipt).toMatchObject({ manifestHash: hash(fs.readFileSync(f.input)), exportComplete: true, complete: false, sourceAcceptance: "HOLD", limits: { readerProfile: PROFILE, reader: { ...reader.GEMINI_LIMITS, bytes: CAP } } });
    expect(receipt.limits).toMatchObject({ physicalReserveBytes: 20 * 1024 ** 3, pendingBytes: 24 * 1024 ** 2, outputBytes: 65536, scratchBytes: 1024 ** 2 + 16384 });
    const start = raw.indexOf(Buffer.from('{"id":"m"')), end = raw.length - 2;
    expect(row.coordinate).toMatchObject({ documentHash: hash(raw), documentBytes: raw.length, utf8ByteStart: start, utf8ByteEndExclusive: end, spanSha256: hash(raw.subarray(start, end)) });
    const fields = row.nativeGeminiTokens.fields;
    expect(Object.fromEntries(Object.entries(fields).map(([k, v]: any) => [k, v.presence]))).toEqual({ input: "value", output: "zero", cached: "null", thoughts: "UNRESOLVED", tool: "absent", total: "value" });
    for (const [key, lexeme] of Object.entries({ input: "7", output: "0", cached: "null", thoughts: "9007199254740993", total: "1.20e1" })) expect(fields[key].sourceSha256).toBe(hash(lexeme));
    expect(fields.tool.sourceSha256).toBeUndefined(); expect(fields.total.value).toBe(12);
    expect(receipt.outputs).toEqual({ metadataSha256: hash(bytes), metadataBytes: bytes.length });
    expect(JSON.stringify(receipt) + bytes + p.stdout + p.stderr).not.toContain("BODY_CANARY");
    expect(hash(fs.readFileSync(f.path))).toBe(hash(raw)); expect(raw.at(-1)).toBe(125);
  } finally { f.clean(); }
});
test("legacy APIs remain lower-only; explicit profile has exact inclusive 16MiB ceiling", () => {
  const raw = body(CAP), copyHash = hash(raw);
  expect(() => reader.projectGeminiJson(raw)).toThrow("GEMINI_BYTE_LIMIT");
  expect(() => reader.projectGeminiJson(raw, { bytes: CAP })).toThrow("GEMINI_LIMIT_CONFIG");
  const result = reader.projectGeminiJsonWithProfile(raw, PROFILE);
  expect(result.documentBytes).toBe(CAP); expect(result.documentHash).toBe(copyHash); expect(hash(raw)).toBe(copyHash);
  expect(() => reader.projectGeminiJsonWithProfile(Buffer.concat([raw, Buffer.from(" ")]), PROFILE)).toThrow("GEMINI_BYTE_LIMIT");
  expect(() => reader.projectGeminiJsonWithProfile(raw, PROFILE, { bytes: CAP + 1 })).toThrow("GEMINI_LIMIT_CONFIG");
  const small = body(reader.GEMINI_LIMITS.bytes); expect(reader.projectGeminiJson(small).documentBytes).toBe(small.length);
  expect(() => reader.projectGeminiJson(Buffer.concat([small, Buffer.from(" ")]))).toThrow("GEMINI_BYTE_LIMIT");
  expect(() => reader.readGeminiJson("/unopened", { documentBytes: CAP, documentHash: copyHash, stat: {} as any }, { bytes: CAP })).toThrow("GEMINI_LIMIT_CONFIG");
});
test("profile never expands parser bounds, duplicate/UTF8 acceptance or elapsed deadline", () => {
  const project = (raw: Buffer | string) => reader.projectGeminiJsonWithProfile(Buffer.from(raw), PROFILE);
  expect(() => project(Buffer.concat([body(2 * 1024 ** 2 + 1), Buffer.from([255])]))).toThrow("GEMINI_UTF8_INVALID");
  expect(() => project('{"messages":[],"messa\\u0067es":[]}')).toThrow("GEMINI_DUPLICATE_KEY");
  expect(() => project('{"messages":[],"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}')).toThrow("GEMINI_DEPTH_LIMIT");
  expect(() => project('{"messages":[],"x":[' + '0,'.repeat(100000) + '0]}')).toThrow("GEMINI_TOKEN_LIMIT");
  expect(() => project('{"messages":[' + Array(10001).fill('null').join(',') + ']}')).toThrow("GEMINI_MESSAGE_LIMIT");
  expect(() => reader.projectGeminiJsonWithProfile(Buffer.from('{"messages":[]}'), PROFILE, { tokens: 1 })).toThrow("GEMINI_TOKEN_LIMIT");
  const clock = spyOn(performance, "now"); let n = 0; clock.mockImplementation(() => n++ * 2000);
  try { expect(() => project('{"messages":[]}')).toThrow("GEMINI_TIME_LIMIT"); } finally { clock.mockRestore(); }
});
test("invalid and ambiguous manifest profiles reject before source or output admission", () => {
  const f = fixture(body(512));
  try {
    const original = fs.openSync, opened: string[] = [];
    const open = spyOn(fs, "openSync").mockImplementation(((path: any, ...args: any[]) => { opened.push(String(path)); return (original as any)(path, ...args); }) as typeof fs.openSync);
    try {
      for (const profile of [null, false, 16, {}, [], "", "default-2mib-v1", "large-document-32mib-v1", { name: PROFILE, bytes: CAP + 1 }]) {
        f.spec.readerProfile = profile; f.save(); expect(() => exportGeminiJson(f.input, f.out)).toThrow("GEMINI_PROFILE_INVALID");
      }
      for (const key of ['readerProfile', 'reader\\u0050rofile']) {
        delete f.spec.readerProfile;
        fs.writeFileSync(f.input, JSON.stringify(f.spec).slice(0, -1) + `,"readerProfile":"${PROFILE}","${key}":"${PROFILE}"}`);
        expect(() => exportGeminiJson(f.input, f.out)).toThrow("GEMINI_MANIFEST_INVALID");
      }
      expect(opened).not.toContain(f.path); expect(fs.existsSync(f.out)).toBe(false);
    } finally { open.mockRestore(); }
    for (const profile of [undefined, null, "unknown", { bytes: CAP + 1 }]) expect(() => reader.projectGeminiJsonWithProfile(Buffer.from("{}"), profile as any)).toThrow("GEMINI_PROFILE_INVALID");
  } finally { f.clean(); }
});
test("profile source refusals leave no consumable output; legacy receipt still binds 2MiB", () => {
  const f = fixture(body(512));
  try {
    f.spec.readerProfile = PROFILE;
    // Preserve the existing pinned reader's diagnostic normalization (UTF8 -> IO_FAILURE).
    for (const [raw, code] of [[Buffer.from('{"messages":[],"messages":[]}'), "DUPLICATE_KEY"], [Buffer.from([255]), "IO_FAILURE"]] as const) {
      fs.writeFileSync(f.path, raw); Object.assign(f.spec.source, { documentBytes: raw.length, documentHash: hash(raw), stat: reader.geminiStatPin(fs.lstatSync(f.path, { bigint: true })) }); f.save();
      const p = f.cli(); expect(p.exitCode).toBe(1); expect(p.stderr.toString()).toContain(`GEMINI_${code}`); expect(fs.existsSync(f.out)).toBe(false);
    }
    f.spec.source.documentBytes = CAP + 1; f.save(); expect(f.cli().stderr.toString()).toContain("GEMINI_SIZE_PIN"); expect(fs.existsSync(f.out)).toBe(false);
    // Expire only after the source budget starts, keeping manifest validation outside this latch.
    let now = 0; f.spec.source.documentBytes = 1; f.save();
    const clock = spyOn(performance, "now").mockImplementation(() => now), original = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(((path: any, ...args: any[]) => {
      const fd = (original as any)(path, ...args); if (path === f.path) now = 2000; return fd;
    }) as typeof fs.openSync);
    try { expect(() => exportGeminiJson(f.input, f.out)).toThrow("GEMINI_TIME_LIMIT"); expect(fs.existsSync(f.out)).toBe(false); }
    finally { open.mockRestore(); clock.mockRestore(); }
  } finally { f.clean(); }
  const legacy = fixture(body(512));
  try { expect(legacy.cli().exitCode).toBe(2); const r = JSON.parse(fs.readFileSync(join(legacy.out, "manifest.json"), "utf8")); expect(r.limits).toMatchObject({ readerProfile: "default-2mib-v1", reader: reader.GEMINI_LIMITS }); }
  finally { legacy.clean(); }
});

test("legacy BOM manifests and explicit profiles preserve original manifest hashes without hiding duplicate declarations", () => {
  for(const profiled of [false,true]) {
    const f=fixture(body(1024));try {
      if(profiled) f.spec.readerProfile=PROFILE;
      const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(f.spec))]);fs.writeFileSync(f.input,bytes);
      const result=f.cli();expect(result.exitCode).toBe(2);
      const receipt=JSON.parse(fs.readFileSync(join(f.out,"manifest.json"),"utf8"));
      expect(receipt.manifestHash).toBe(hash(bytes));expect(receipt.limits.readerProfile).toBe(profiled?PROFILE:"default-2mib-v1");
    } finally {f.clean();}
  }
  for(const prefix of ["\ufeff\ufeff"," \ufeff"]) {
    const f=fixture(body(1024));try {fs.writeFileSync(f.input,prefix+JSON.stringify(f.spec));expect(f.cli().exitCode).toBe(1);expect(fs.existsSync(f.out)).toBe(false);} finally {f.clean();}
  }
  const f=fixture(body(1024));try {
    const duplicate='\ufeff'+JSON.stringify(f.spec).replace('"version":1','"version":1,"readerProfile":"'+PROFILE+'","reader\\u0050rofile":"'+PROFILE+'"');
    fs.writeFileSync(f.input,duplicate);expect(f.cli().exitCode).toBe(1);expect(fs.existsSync(f.out)).toBe(false);
  } finally {f.clean();}
});
