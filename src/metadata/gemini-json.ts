import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isAbsolute, normalize } from "node:path";

export const GEMINI_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, depth: 64, tokens: 100_000, messages: 10_000, milliseconds: 1000 });
export type GeminiLimits = { readonly [K in keyof typeof GEMINI_LIMITS]: number };
type Kind = "object" | "array" | "string" | "number" | "null" | "boolean";
type Node = { start: number; end: number; kind: Kind; fields?: Map<string, Node>; items?: Node[] };
export type GeminiField = { presence: "absent" | "null" | "zero" | "value" | "UNRESOLVED"; value?: string | number | null; sourceSha256?: string };
export type GeminiStatPin = { dev: string; ino: string; size: string; birthtimeNs: string; mtimeNs: string; ctimeNs: string };
export type GeminiFilePin = { documentBytes: number; documentHash: string; stat: GeminiStatPin };
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const fail = (label: string): never => { throw new Error(`GEMINI_${label}`); };
export function geminiStatPin(s: fs.BigIntStats): GeminiStatPin {
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), birthtimeNs: String(s.birthtimeNs), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
}
function budget(options: Partial<GeminiLimits>) {
  const limits = { ...GEMINI_LIMITS, ...options }, started = performance.now();
  for (const k of Object.keys(GEMINI_LIMITS) as (keyof GeminiLimits)[])
    if (!Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > GEMINI_LIMITS[k]) fail("LIMIT_CONFIG");
  return { limits, check: () => { if (performance.now() - started >= limits.milliseconds) fail("TIME_LIMIT"); } };
}
/** JSON byte scanner. Never reserialize; reject decoded duplicate keys, including body keys. */
function scan(raw: Buffer, b: ReturnType<typeof budget>): Node {
  let at = 0, tokens = 0;
  const ws = () => { while ([32, 9, 10, 13].includes(raw[at])) { at++; if (at % 4096 === 0) b.check(); } };
  const text = () => {
    const start = at++;
    while (at < raw.length) {
      if (at % 4096 === 0) b.check();
      const ch = raw[at++];
      if (ch === 34) {
        try { return JSON.parse(raw.subarray(start, at).toString("utf8")) as string; } catch { fail("JSON_INVALID"); }
      }
      if (ch === 92) at++; // JSON.parse validates all escapes and unescaped control bytes.
    }
    return fail("JSON_INVALID");
  };
  const value = (depth: number): Node => {
    b.check(); if (depth > b.limits.depth) fail("DEPTH_LIMIT");
    if (++tokens > b.limits.tokens) fail("TOKEN_LIMIT");
    ws(); const start = at, ch = raw[at];
    let node: Node;
    if (ch === 123 || ch === 91) {
      at++; ws(); const object = ch === 123, close = object ? 125 : 93;
      node = { start, end: 0, kind: object ? "object" : "array", ...(object ? { fields: new Map() } : { items: [] }) };
      if (raw[at] !== close) for (;;) {
        if (object) {
          if (++tokens > b.limits.tokens) fail("TOKEN_LIMIT");
          if (raw[at] !== 34) fail("JSON_INVALID");
          const key = text(); ws(); if (raw[at++] !== 58) fail("JSON_INVALID");
          if (node.fields!.has(key)) fail("DUPLICATE_KEY");
          node.fields!.set(key, value(depth + 1));
        } else {
          // Count all arrays under the token bound; the messages array has an additional cap below.
          node.items!.push(value(depth + 1));
        }
        ws(); if (raw[at] === close) break;
        if (raw[at++] !== 44) fail("JSON_INVALID"); ws();
      }
      at++;
    } else if (ch === 34) { text(); node = { start, end: 0, kind: "string" }; }
    else {
      while (at < raw.length && ![32, 9, 10, 13, 44, 93, 125].includes(raw[at])) { at++; if (at % 4096 === 0) b.check(); }
      const lexeme = raw.subarray(start, at).toString("utf8");
      const kind = lexeme === "null" ? "null" : /^(true|false)$/.test(lexeme) ? "boolean" :
        /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(lexeme) ? "number" : fail("JSON_INVALID");
      node = { start, end: 0, kind };
    }
    node.end = at; return node;
  };
  const root = value(0); ws(); if (at !== raw.length) fail("JSON_INVALID"); return root;
}
/** Accept exact nonnegative safe integers, including exact decimal/exponent forms, without rounding. */
function integer(lexeme: string): number | undefined {
  if (lexeme.length > 128) return;
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme);
  if (!m) return;
  let digits = (m[1] + (m[2] ?? "")).replace(/^0+/, ""), scale = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  if (!digits) return 0;
  if (!Number.isSafeInteger(scale) || digits.length + scale > 16 || digits.length + scale < 1) return;
  if (scale < 0) {
    if (!/^0*$/.test(digits.slice(digits.length + scale))) return;
    digits = digits.slice(0, digits.length + scale);
  } else digits += "0".repeat(scale);
  const n = Number(digits); return Number.isSafeInteger(n) ? n : undefined;
}
function project(raw: Buffer, b: ReturnType<typeof budget>) {
  b.check(); if (raw.length > b.limits.bytes) fail("BYTE_LIMIT");
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { fail("UTF8_INVALID"); }
  const root = scan(raw, b), messages = root.fields?.get("messages");
  if (root.kind !== "object" || !messages || messages.kind !== "array") return fail("ROOT_INVALID");
  if (messages.items!.length > b.limits.messages) fail("MESSAGE_LIMIT");
  const slice = (n: Node) => raw.subarray(n.start, n.end);
  const field = (n: Node | undefined, kind: "string" | "clock" | "counter" = "string"): GeminiField => {
    if (!n) return { presence: "absent" };
    const sourceSha256 = digest(slice(n));
    if (n.kind === "null") return { presence: "null", value: null, sourceSha256 };
    if (kind === "counter") {
      const v = n.kind === "number" ? integer(slice(n).toString("utf8")) : undefined;
      return v === undefined ? { presence: "UNRESOLVED", sourceSha256 } : { presence: v === 0 ? "zero" : "value", value: v, sourceSha256 };
    }
    if (n.kind === "string" && n.end - n.start <= 16384) {
      const v = JSON.parse(slice(n).toString("utf8")) as string;
      // Preserve the original clock text; validate the calendar without normalization/carry-forward.
      const clock = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(v);
      const year = Number(clock?.[1]), month = Number(clock?.[2]), day = Number(clock?.[3]);
      const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const zone = clock?.[7];
      const valid = clock && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
        Number(clock[4]) < 24 && Number(clock[5]) < 60 && Number(clock[6]) < 60 &&
        (zone === "Z" || (Number(zone?.slice(1,3)) < 24 && Number(zone?.slice(4)) < 60));
      if (kind !== "clock" || valid) return { presence: "value", value: v, sourceSha256 };
    }
    return { presence: "UNRESOLVED", sourceSha256 };
  };
  const documentHash = digest(raw), documentBytes = raw.length;
  const names = ["input", "output", "cached", "thoughts", "tool", "total"] as const;
  const rows = messages.items!.map((n, i) => {
    b.check(); const f = n.fields, token = f?.get("tokens"), tf = token?.fields;
    const unknownKeyCount = tf ? [...tf.keys()].filter(k => !names.includes(k as typeof names[number])).length : 0;
    return { documentHash, documentBytes, jsonPointer: `/messages/${i}`, arrayIndex: i, outputOrdinal: i + 1,
      utf8ByteStart: n.start, utf8ByteEndExclusive: n.end, spanBytes: n.end - n.start, spanSha256: digest(slice(n)),
      originalLFLine: "NOT_APPLICABLE" as const, status: n.kind === "object" ? "PROJECTED" as const : "UNSUPPORTED_ELEMENT" as const,
      id: field(f?.get("id")), type: field(f?.get("type")), timestamp: field(f?.get("timestamp"), "clock"), model: field(f?.get("model")),
      nativeGeminiTokens: { presence: !token ? "absent" as const : token.kind === "null" ? "null" as const : tf && !unknownKeyCount ? "value" as const : "UNRESOLVED" as const,
        ...(token ? { sourceSha256: digest(slice(token)) } : {}), unknownKeyCount,
        fields: Object.fromEntries(names.map(k => [k, field(tf?.get(k), "counter")])) as Record<typeof names[number], GeminiField> },
      counterBasis: "RECORDED_GEMINI_MESSAGE_SNAPSHOT" as const, deltaBasis: "UNKNOWN" as const, upstreamPresence: "UNKNOWN" as const };
  });
  const f = root.fields!;
  b.check(); const result = { provider: "gemini-cli" as const, sourceFormat: "gemini-chat-json" as const, coordinateKind: "json-utf8-span-v1" as const,
    documentHash, documentBytes, nativeSessionId: { ...field(f.get("sessionId")), jsonPointer: "/sessionId" }, nativeProjectHash: { ...field(f.get("projectHash")), jsonPointer: "/projectHash" },
    startTime: { ...field(f.get("startTime"), "clock"), jsonPointer: "/startTime" }, lastUpdated: { ...field(f.get("lastUpdated"), "clock"), jsonPointer: "/lastUpdated" },
    historicalWriterVersion: "UNKNOWN" as const, messages: rows };
  b.check(); return result;
}
export type GeminiProjection = ReturnType<typeof project>;
/** Pure synthetic/caller-buffer projection; no custody/origin is inferred and the buffer is never changed. */
export function projectGeminiJson(raw: Buffer, limits: Partial<GeminiLimits> = {}): GeminiProjection {
  return project(raw, budget(limits));
}
/** Exact pinned immutable revision. No enumeration, output writes, follow-on source or producer call. */
export function readGeminiJson(path: string, pin: GeminiFilePin, limits: Partial<GeminiLimits> = {}): GeminiProjection {
  const b = budget(limits);
  if (!Number.isSafeInteger(pin.documentBytes) || pin.documentBytes < 1 || pin.documentBytes > b.limits.bytes) fail("SIZE_PIN");
  if (!/^[a-f0-9]{64}$/.test(pin.documentHash)) fail("HASH_PIN");
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || normalize(path) !== path || fs.realpathSync(path) !== path) fail("PATH_INVALID");
    const before = fs.lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) fail("FILE_INVALID");
    const match = (s: fs.BigIntStats) => {
      if (!s.isFile() || Object.entries(pin.stat).length !== 6 ||
        (Object.keys(geminiStatPin(s)) as (keyof GeminiStatPin)[]).some(k => geminiStatPin(s)[k] !== pin.stat[k])) fail("STAT_PIN");
    };
    match(before);
    if (before.size !== BigInt(pin.documentBytes)) fail("SIZE_PIN");
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    match(fs.fstatSync(fd, { bigint: true }));
    const raw = Buffer.alloc(pin.documentBytes), probe = Buffer.alloc(1); let offset = 0, reads = 0;
    for (;;) {
      b.check(); if (++reads > pin.documentBytes + 1) fail("READ_LIMIT");
      const remaining = raw.length - offset;
      const n = fs.readSync(fd, remaining ? raw : probe, remaining ? offset : 0, Math.min(remaining || 1, 65536), null);
      if (!n) break;
      if (!remaining) fail("FILE_GROWTH");
      offset += n;
    }
    if (offset !== pin.documentBytes) fail("SHORT_FILE");
    match(fs.fstatSync(fd, { bigint: true })); match(fs.lstatSync(path, { bigint: true }));
    if (fs.realpathSync(path) !== path) fail("PATH_INVALID");
    if (digest(raw) !== pin.documentHash) fail("HASH_PIN");
    const result = project(raw, b);
    match(fs.fstatSync(fd, { bigint: true })); match(fs.lstatSync(path, { bigint: true }));
    if (fs.realpathSync(path) !== path) fail("PATH_INVALID");
    b.check(); return result;
  } catch (e) {
    if (e instanceof Error && /^GEMINI_[A-Z_]+$/.test(e.message)) throw e;
    return fail("IO_FAILURE");
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { fail("IO_FAILURE"); } } }
}
