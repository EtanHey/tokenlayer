import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseLine, projectFromCwd, type FileState } from "./parse";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => isObj(v) ? v : {};
const str = (v: unknown) => typeof v === "string" ? v : "";

/** T3 and CLI share ~/.kiro/sessions. Join native ids, never infer harness from cwd. */
export function kiroT3Sessions(path?: string): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_provider_threads'").get()) return new Set();
    const rows = db.query<{ id: string }, []>(`SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS id
      FROM orchestration_v2_projection_provider_threads WHERE driver = 'kiro' AND json_type(payload_json, '$.nativeThreadRef.nativeId') = 'text'`).all();
    return new Set(rows.map(r => r.id));
  } finally { db.close(); }
}

export function kiroSession(root: string, path: string): string {
  return /^[^/]+\/([^/]+)\/messages\.jsonl$/.exec(relative(root, path))?.[1] ?? "";
}

export function kiroMetadata(path: string, previous = { cwd: "", model: "" }) {
  let o: Obj = {};
  try { o = obj(JSON.parse(readFileSync(join(dirname(path), "session.json"), "utf8"))); } catch {}
  const paths = Array.isArray(o.workspacePaths) ? o.workspacePaths : [];
  return { cwd: str(paths[0]) || previous.cwd, model: str(o.modelId) || previous.model };
}

/** The observed usage_summary is per turn; context usage percentages are not billing usage. */
export function parseKiro(line: string, state: FileState) {
  const row = parseLine(line);
  const o = row.type === "invalid" ? {} : obj(JSON.parse(line));
  const p = obj(o.payload);
  const type = str(p.type);
  const summaries = Array.isArray(p.promptTurnSummaries) ? p.promptTurnSummaries : [];
  const credits = summaries.filter(s => obj(s).unit === "credit").map(s => obj(s).usage);
  const id = str(p.turnId) || str(p.executionId);
  const known = !!id && type === "usage_summary" && credits.length > 0 && credits.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return { ...row, session_id: state.sessionId, session_alias: "", cwd: state.cwd,
    project: projectFromCwd(state.cwd), model: state.model, type: `kiro:${type || row.type}`,
    role: type === "user" || type === "assistant" ? type : "",
    message_id: type === "usage_summary" ? id : "",
    credits: known ? credits.reduce<number>((sum, v) => sum + (typeof v === "number" ? v : 0), 0) : null };
}
