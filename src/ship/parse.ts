import { basename } from "node:path";
import { parseTimestampMs, toClickHouseTime } from "../lib/time";

export type SourceKind = "claude" | "codex";
export type Harness = "claude" | "codex" | "t3";

/** Per-file carry-forward context. Persisted in the checkpoint so a resumed file parses like an unbroken one. */
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

const RECENT_IDS = 64;

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

/** Repo name for a cwd: `<repo>/.worktrees/<x>` and `~/.t3/worktrees/<repo>/<x>` map to `<repo>`. */
export function projectFromCwd(cwd: string): string {
  if (!cwd) return "";
  const t3 = /\/\.t3\/worktrees\/([^/]+)/.exec(cwd);
  if (t3) return t3[1];
  const wt = /\/([^/]+)\/\.(?:worktrees|claude\/worktrees)\//.exec(cwd);
  if (wt) return wt[1];
  return basename(cwd.replace(/\/+$/, ""));
}

const zeroTokens = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0 };

function claudeColumns(o: Obj, st: FileState) {
  st.sessionId = str(o.sessionId) || str(o.session_id) || st.sessionId;
  st.cwd = str(o.cwd) || st.cwd;
  const msg = isObj(o.message) ? o.message : {};
  const model = str(msg.model);
  if (model && model !== "<synthetic>") st.model = model;
  const id = str(msg.id);
  let tokens = zeroTokens;
  const usage = isObj(msg.usage) ? msg.usage : null;
  if (usage && id && !st.recentIds.includes(id)) {
    st.recentIds.push(id);
    if (st.recentIds.length > RECENT_IDS) st.recentIds.shift();
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

function codexColumns(o: Obj, st: FileState) {
  const p = isObj(o.payload) ? o.payload : {};
  const type = str(o.type);
  let role = str(p.role) || str(p.type);
  let message_id = "";
  let tokens = zeroTokens;
  if (type === "session_meta") {
    st.sessionId = str(p.session_id) || str(p.id) || st.sessionId;
    st.cwd = str(p.cwd) || st.cwd;
    role = "";
  } else if (type === "turn_context") {
    st.cwd = str(p.cwd) || st.cwd;
    st.model = str(p.model) || st.model;
  } else if (type === "token_usage_record") {
    message_id = str(p.response_id);
    st.sessionId = st.sessionId || str(p.session_id);
  } else if (type === "event_msg" && p.type === "token_count" && isObj(p.info)) {
    const total = JSON.stringify(p.info.total_token_usage ?? null);
    const last = isObj(p.info.last_token_usage) ? p.info.last_token_usage : null;
    if (last && total !== st.lastCodexTotal) {
      st.lastCodexTotal = total;
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
  return { type, role, model: st.model, message_id, ...tokens };
}

/**
 * Parse one JSONL line into session_events columns, updating the file's carry-forward state.
 * Token columns are credited once per API response: input_tokens is uncached input for both harnesses.
 */
export function parseLine(line: string, st: FileState): ParsedLine {
  const o = tryParse(line);
  if (!o) {
    return {
      ts: toClickHouseTime(st.lastTsMs),
      session_id: st.sessionId,
      project: projectFromCwd(st.cwd),
      cwd: st.cwd,
      type: "invalid",
      role: "",
      model: "",
      message_id: "",
      ...zeroTokens,
      raw: line,
    };
  }
  const ms = parseTimestampMs(o.timestamp);
  if (ms !== null) st.lastTsMs = ms;
  const cols = st.kind === "claude" ? claudeColumns(o, st) : codexColumns(o, st);
  return {
    ts: toClickHouseTime(st.lastTsMs),
    session_id: st.sessionId,
    project: projectFromCwd(st.cwd),
    cwd: st.cwd,
    ...cols,
    raw: line,
  };
}
