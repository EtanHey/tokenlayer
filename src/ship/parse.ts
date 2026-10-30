import { repoFromCwd } from "../lib/repo";
import { parseTimestampMs, toClickHouseTime } from "../lib/time";

export type SourceKind = "claude" | "codex" | "antigravity-cli" | "t3-antigravity";
export type Harness = "claude" | "codex" | "t3" | "antigravity";

/** V3 checkpoint shape. Antigravity uses native metadata and timestamp carry-forward. */
export type FileState = {
  kind: SourceKind;
  harness: Harness;
  lastTsMs: number;
  sessionId: string;
  cwd: string;
  model: string;
  /** Claude: recent message ids already credited (one API response is split across several lines). */
  recentIds: string[];
  /** Codex: last total_token_usage seen (token_count events repeat on rate-limit refreshes). */
  lastCodexTotal: string;
};

export type ParsedLine = {
  ts: string;
  session_id: string;
  session_alias: string;
  project: string;
  cwd: string;
  type: string;
  role: string;
  model: string;
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  raw: string;
};

export function newFileState(kind: SourceKind, harness: Harness, defaultTsMs: number): FileState {
  return { kind, harness, lastTsMs: defaultTsMs, sessionId: "", cwd: "", model: "", recentIds: [], lastCodexTotal: "" };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const uint = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

function tryParse(line: string): Obj | null {
  try {
    const v = JSON.parse(line) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Decide the harness from a file's first lines. Claude Code files written by T3 Code carry
 * `entrypoint: "sdk-ts"` (T3 drives Claude through the Agent SDK); Codex files written by T3 carry
 * `session_meta.payload.originator: "T3 Code"`. Returns null while the head has no deciding line.
 */
export function detectHarness(kind: SourceKind, headLines: string[]): Harness | null {
  if (kind === "antigravity-cli") return "antigravity";
  if (kind === "t3-antigravity") return "t3";
  for (const line of headLines) {
    const o = tryParse(line);
    if (!o) continue;
    if (kind === "claude") {
      const ep = str(o.entrypoint);
      if (ep) return ep === "sdk-ts" ? "t3" : "claude";
    } else if (o.type === "session_meta" && isObj(o.payload)) {
      return str(o.payload.originator) === "T3 Code" ? "t3" : "codex";
    }
  }
  return null;
}

/** Missing cwd remains empty in the archive; attribution is completed by the context view. */
export function projectFromCwd(cwd: string): string {
  return cwd ? repoFromCwd(cwd) : "";
}

const zeroTokens = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0 };

function claudeColumns(o: Obj) {
  const msg = isObj(o.message) ? o.message : {};
  const model = str(msg.model);
  const id = str(msg.id);
  let tokens = zeroTokens;
  const usage = isObj(msg.usage) ? msg.usage : null;
  if (usage && id) {
    const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : {};
    tokens = {
      input_tokens: uint(usage.input_tokens),
      output_tokens: uint(usage.output_tokens),
      cache_read_tokens: uint(usage.cache_read_input_tokens),
      cache_creation_tokens: uint(usage.cache_creation_input_tokens),
      reasoning_tokens: uint(details.thinking_tokens),
    };
  }
  return { type: str(o.type), role: str(msg.role), model: model && model !== "<synthetic>" ? model : "", message_id: id, ...tokens };
}

function codexColumns(o: Obj) {
  const p = isObj(o.payload) ? o.payload : {};
  const type = str(o.type);
  let role = str(p.role) || str(p.type);
  let message_id = "";
  let tokens = zeroTokens;
  if (type === "session_meta") {
    role = "";
  } else if (type === "token_usage_record") {
    message_id = str(p.response_id);
  } else if (type === "event_msg" && p.type === "token_count" && isObj(p.info)) {
    const last = isObj(p.info.last_token_usage) ? p.info.last_token_usage : null;
    if (last) {
      const input = uint(last.input_tokens);
      const cached = uint(last.cached_input_tokens);
      tokens = {
        input_tokens: Math.max(0, input - cached),
        output_tokens: uint(last.output_tokens),
        cache_read_tokens: cached,
        cache_creation_tokens: uint(last.cache_write_input_tokens),
        reasoning_tokens: uint(last.reasoning_output_tokens),
      };
    }
  }
  return { type, role, model: str(p.model), message_id, ...tokens };
}

/**
 * Archive columns are pure functions of this line. Missing time is the Unix epoch; missing text is empty.
 * Token columns retain line-local usage (uncached input). Attribution/crediting belongs to the context view.
 * The optional legacy state argument is ignored and never mutated.
 */
export function parseLine(line: string, _legacyState?: FileState): ParsedLine {
  const o = tryParse(line);
  if (!o) {
    return {
      ts: toClickHouseTime(0),
      session_id: "",
      session_alias: "",
      project: "",
      cwd: "",
      type: "invalid",
      role: "",
      model: "",
      message_id: "",
      ...zeroTokens,
      raw: line,
    };
  }
  const p = isObj(o.payload) ? o.payload : {};
  const cwd = str(o.cwd) || str(p.cwd);
  const cols = isObj(o.payload) ? codexColumns(o) : claudeColumns(o);
  return {
    ts: toClickHouseTime(parseTimestampMs(o.timestamp) ?? 0),
    session_id: (o.type === "session_meta" ? str(p.id) : "") || str(o.sessionId) || str(o.session_id) || str(p.session_id),
    session_alias: o.type === "session_meta" ? str(p.session_id) : "",
    project: projectFromCwd(cwd),
    cwd,
    ...cols,
    raw: line,
  };
}
