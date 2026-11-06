import * as fs from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { sanitizeOutput } from "../lib/egress";
import { assertGeminiJsonUniqueKeys, geminiStatPin, type GeminiStatPin } from "./gemini-json";
import { ProjectionError } from "./output";
import { hash } from "./stream";

export const CURSOR_PROJECT_LIMITS = Object.freeze({ bytes: 16 * 1024 ** 2, lineBytes: 1024 ** 2,
  lines: 10_000, blocks: 256, outputBytes: 16 * 1024 ** 2, milliseconds: 2000 });
type Limits = { readonly [K in keyof typeof CURSOR_PROJECT_LIMITS]: number };
type Obj = Record<string, unknown>;
type Field = { presence: "absent" | "null" | "zero" | "value" | "UNRESOLVED";
  value?: string | number | boolean | null; fields?: Record<string, Field>; unknown?: { keySha256: string; field: Field }[] };
export type CursorProjectPin = { bytes: number; sha256: string; stat: GeminiStatPin };
const fail = (code: string): never => { throw new ProjectionError(`CURSOR_${code}`); };
const object = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const ids = ["id", "nativeId", "uuid", "sessionId", "session_id", "agentId", "requestId", "request_id",
  "responseId", "response_id", "callId", "call_id", "tool_call_id", "parentId", "parent_id", "parentUuid", "parentAgentId"];
const lifecycle = ["createdAt", "created_at", "updatedAt", "updated_at"];
const eventClocks = ["timestamp", "startedAt", "completedAt", "startTime", "endTime"];
const clocks = [...eventClocks, ...lifecycle];
const scope = ["client", "clientId", "accountId", "model", "provider"];
const counters = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "reasoning_output_tokens", "total_tokens", "prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens",
  "cache_creation", "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens", "prompt_tokens_details", "completion_tokens_details"];
const usageKeys = ["usage", "tokens"];
const absent = (): Field => ({ presence: "absent" });
/** No redacted substitution can become an identity. Unsafe metadata remains an explicit gap. */
function scalar(v: unknown): Field {
  if (v === null) return { presence: "null", value: null };
  if (typeof v === "number" && Number.isSafeInteger(v)) return { presence: v === 0 ? "zero" : "value", value: v };
  if (typeof v === "string" && v.length <= 512 && /^[A-Za-z0-9._:@/+ =-]*$/.test(v) && sanitizeOutput(v) === v)
    return { presence: "value", value: v };
  return { presence: "UNRESOLVED" };
}
const field = (o: Obj, k: string) => Object.hasOwn(o, k) ? scalar(o[k]) : absent();
const pick = (o: Obj, keys: string[]) => Object.fromEntries(keys.map(k => [k, field(o, k)]));
/** Preserve numeric components independently, including unfamiliar names via non-disclosing name hashes. */
function counter(v: unknown, depth = 0): Field {
  if (depth > 8) return { presence: "UNRESOLVED" };
  if (v === null || typeof v === "number") return scalar(v);
  if (!v || typeof v !== "object" || Array.isArray(v)) return { presence: "UNRESOLVED" };
  const o = object(v), names = depth === 0 ? [...new Set([...counters, ...Object.keys(o)])] : Object.keys(o);
  const fields: Record<string, Field> = {}, unknown: { keySha256: string; field: Field }[] = [];
  for (const k of names) {
    const f = Object.hasOwn(o, k) ? counter(o[k], depth + 1) : absent();
    if (counters.includes(k)) fields[k] = f; else unknown.push({ keySha256: hash(k), field: f });
  }
  return { presence: "value", fields, unknown };
}
function metadata(o: Obj) {
  return { ids: pick(o, ids), clocks: pick(o, clocks), scope: pick(o, scope),
    usage: Object.fromEntries(usageKeys.map(k => [k, Object.hasOwn(o, k) ? counter(o[k]) : absent()])) };
}
const unknownKeys = (o: Obj, extra: string[]) => Object.keys(o)
  .filter(k => ![...ids, ...clocks, ...scope, ...usageKeys, ...extra].includes(k)).length;
/** Never let JSON rounding manufacture exact counters. Skip quoted strings, including escapes.
 * Noncanonical numbers conservatively taint equal decoded numbers throughout this LF record. */
function parseExactNumbers(text: string): unknown {
  const ambiguous = new Set<number>(), unresolved = Symbol("unresolved-number");
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (!m[1]) continue;
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || String(n) !== m[1]) ambiguous.add(n);
  }
  return JSON.parse(text, (_key, value: unknown) => typeof value === "number" && ambiguous.has(value) ? unresolved : value);
}
function bounds(options: Partial<Limits>) {
  const limits = { ...CURSOR_PROJECT_LIMITS, ...options }, start = performance.now();
  for (const k of Object.keys(limits) as (keyof Limits)[])
    if (!(k in CURSOR_PROJECT_LIMITS) || !Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > CURSOR_PROJECT_LIMITS[k]) fail("LIMIT_CONFIG");
  return { limits, check: () => { if (performance.now() - start >= limits.milliseconds) fail("TIME_LIMIT"); } };
}
type Metadata = { role: Field; outer: ReturnType<typeof metadata>; message: ReturnType<typeof metadata>;
  contentBlocks: (ReturnType<typeof metadata> & { index: number; type: Field; unsupportedKeys: number })[];
  unknownTopLevelKeys: number; unknownMessageKeys: number };
type Row = { originalLFLine: number; utf8ByteStart: number; utf8ByteEndExclusive: number; recordBytes: number;
  recordSha256: string; terminated: boolean; status: string; metadata?: Metadata; gaps: string[] };
function project(raw: Buffer, b: ReturnType<typeof bounds>) {
  const { limits, check } = b; check(); if (raw.length > limits.bytes) fail("BYTE_LIMIT");
  const records: Row[] = []; let at = 0, outputBytes = 0;
  while (at < raw.length) {
    check(); if (records.length >= limits.lines) fail("LINE_LIMIT");
    const nl = raw.indexOf(10, at), end = nl < 0 ? raw.length : nl + 1, bytes = raw.subarray(at, end);
    const row: Row = { originalLFLine: records.length + 1, utf8ByteStart: at, utf8ByteEndExclusive: end,
      recordBytes: bytes.length, recordSha256: hash(bytes), terminated: nl >= 0, status: "PROJECTED", gaps: [] };
    if (bytes.length > limits.lineBytes) row.status = "OVERSIZE_LINE";
    else if (nl < 0) row.status = "UNTERMINATED_LF";
    else {
      let o: Obj | undefined;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        try { assertGeminiJsonUniqueKeys(bytes); o = object(parseExactNumbers(decoded)); }
        catch (e) { row.status = e instanceof Error && /^GEMINI_(DEPTH|TOKEN|TIME|BYTE)_LIMIT$/.test(e.message) ? "PARSER_LIMIT" : "INVALID_JSON"; }
      } catch { row.status = "INVALID_UTF8"; }
      if (o) {
        const msg = object(o.message), content = msg.content;
        if (typeof o.role !== "string" || !["user", "assistant", "system", "tool"].includes(o.role) || !Array.isArray(content)) row.status = "UNSUPPORTED_SHAPE";
        else {
          if (content.length > limits.blocks) fail("BLOCK_LIMIT");
          if (content.some(v => v === null || typeof v !== "object" || Array.isArray(v))) row.gaps.push("UNSUPPORTED_CONTENT_BLOCK");
          row.metadata = { role: field(o, "role"), outer: metadata(o), message: metadata(msg),
            contentBlocks: content.map((v, index) => ({ index, type: field(object(v), "type"), ...metadata(object(v)),
              unsupportedKeys: unknownKeys(object(v), ["type", "text", "input", "name"]) })),
            unknownTopLevelKeys: unknownKeys(o, ["role", "message"]), unknownMessageKeys: unknownKeys(msg, ["role", "content"]) };
          if (row.metadata.unknownTopLevelKeys) row.gaps.push("UNSUPPORTED_TOP_LEVEL_FIELDS");
          if (row.metadata.unknownMessageKeys || row.metadata.contentBlocks.some(v => v.unsupportedKeys)) row.gaps.push("UNSUPPORTED_NESTED_FIELDS");
          if (![o, msg, ...content.map(object)].some(v => eventClocks.some(k => Object.hasOwn(v, k) && ["value", "zero"].includes(field(v, k).presence)))) row.gaps.push("EVENT_CLOCK_UNKNOWN");
          if ([o, msg, ...content.map(object)].every(v => usageKeys.every(k => !Object.hasOwn(v, k)))) row.gaps.push("COUNTERS_ABSENT");
          if (JSON.stringify(row.metadata).includes('"UNRESOLVED"')) row.gaps.push("UNSUPPORTED_METADATA");
        }
      }
    }
    if (row.status !== "PROJECTED") row.gaps.push(row.status);
    outputBytes += Buffer.byteLength(JSON.stringify(row)); if (outputBytes > limits.outputBytes) fail("OUTPUT_LIMIT");
    records.push(row); at = end;
  }
  check();
  const result = { sourceFormat: "cursor-project-transcript-jsonl" as const, sourceSha256: hash(raw), sourceBytes: raw.length,
    records, limits, complete: false as const, sourceAcceptance: "HOLD" as const, counterSemantics: "UNKNOWN" as const,
    eventClockSemantics: "RECORDED_FIELDS_ONLY_UNVERIFIED" as const, creationIsEvent: false as const,
    continuity: "UNKNOWN" as const, historicalWriter: "UNKNOWN" as const,
    gaps: ["ACCOUNT_CLIENT_ORIGIN_ONLY_WHEN_RECORDED", "NATIVE_COPY_TEST_AND_PARENT_RECONCILIATION_UNKNOWN",
      "BILLING_DURATION_DEDUP_NOT_DETERMINED", ...(records.length ? [] : ["NO_RECORDS"])] };
  check(); return result;
}
/** Pure caller-buffer projection. No body metadata, output writes, path-derived identity or arithmetic. */
export function projectCursorProjectJsonl(raw: Buffer, options: Partial<Limits> = {}) {
  return project(raw, bounds(options));
}
/** One explicitly pinned regular file; no enumeration, writes, export controller or automatic retries. */
export function readCursorProjectJsonl(path: string, pin: CursorProjectPin, options: Partial<Limits> = {}) {
  const b = bounds(options); let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 0 || pin.bytes > b.limits.bytes) fail("SIZE_PIN");
    if (!/^[a-f0-9]{64}$/.test(pin.sha256)) fail("HASH_PIN");
    const match = (s: fs.BigIntStats) => {
      const actual = geminiStatPin(s);
      if (!s.isFile() || s.size !== BigInt(pin.bytes) || Object.keys(pin.stat).length !== 6 ||
        (Object.keys(actual) as (keyof GeminiStatPin)[]).some(k => pin.stat[k] !== actual[k])) fail("STAT_PIN");
    };
    const pathCheck = () => { if (!isAbsolute(path) || normalize(path) !== path || fs.realpathSync(path) !== path) fail("PATH"); };
    pathCheck(); match(fs.lstatSync(path, { bigint: true }));
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    match(fs.fstatSync(fd, { bigint: true }));
    const raw = Buffer.alloc(pin.bytes), probe = Buffer.alloc(1); let at = 0;
    for (;;) {
      b.check(); const remaining = raw.length - at;
      const n = fs.readSync(fd, remaining ? raw : probe, remaining ? at : 0, Math.min(remaining || 1, 65536), null);
      if (!n) break; if (!remaining) fail("FILE_GROWTH"); at += n;
    }
    if (at !== pin.bytes) fail("SHORT_FILE");
    match(fs.fstatSync(fd, { bigint: true })); match(fs.lstatSync(path, { bigint: true })); pathCheck();
    if (hash(raw) !== pin.sha256) fail("HASH_PIN");
    const result = project(raw, b);
    match(fs.fstatSync(fd, { bigint: true })); match(fs.lstatSync(path, { bigint: true })); pathCheck(); b.check();
    return result;
  } catch (e) {
    if (e instanceof ProjectionError) throw e;
    return fail("IO_FAILURE");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
