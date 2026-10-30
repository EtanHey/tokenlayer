import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimestampMs, toClickHouseTime } from "../lib/time";
import { parseLine, projectFromCwd, type FileState, type SourceKind } from "./parse";

export const isAntigravity = (kind: SourceKind) => kind === "antigravity-cli" || kind === "t3-antigravity";
export function antigravitySession(dir: string, path: string, kind: SourceKind): string {
  const pattern = kind === "antigravity-cli" ? /^([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/
    : /^[^/]+\/antigravity-acp\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/;
  return pattern.exec(relative(dir, path))?.[1] ?? "";
}

/** Only query workspace metadata, never payloads, prompts, auth files or opaque summary blobs. */
export function antigravityCwd(dir: string, path: string, session: string, kind: SourceKind): string {
  if (kind === "t3-antigravity") {
    const meta = join(path, "../../../../../conversations", `${session}.meta`);
    if (!existsSync(meta)) return "";
    const { cwd } = JSON.parse(readFileSync(meta, "utf8"));
    return typeof cwd === "string" ? cwd : "";
  }
  const dbPath = join(dirname(dir), "conversation_summaries.db");
  if (!existsSync(dbPath)) return "";
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?").get(session) as { workspace_uris: string } | null;
    const uris: unknown = row?.workspace_uris ? JSON.parse(row.workspace_uris) : [];
    const uri = Array.isArray(uris) ? uris.find(u => typeof u === "string" && u.startsWith("file://")) : undefined;
    return uri ? fileURLToPath(uri) : "";
  } finally { db.close(); }
}

/** Timestamp carry-forward is persisted only after insertion; a missing initial time fails closed. */
export function parseAntigravity(line: string, state: FileState) {
  const row = parseLine(line);
  const o = row.type === "invalid" ? {} : JSON.parse(line);
  const ts = parseTimestampMs(o.created_at);
  if (ts !== null && ts > 0) state.lastTsMs = ts;
  if (state.lastTsMs <= 0) throw new Error("Antigravity record has no preceding timestamp");
  const uint = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  return { ...row, ts: toClickHouseTime(state.lastTsMs), session_id: state.sessionId, session_alias: "",
    cwd: state.cwd, project: projectFromCwd(state.cwd), model: "", role: "", message_id: "",
    input_tokens: uint(o.input_tokens), output_tokens: uint(o.output_tokens), cache_read_tokens: uint(o.cache_read_tokens) };
}
