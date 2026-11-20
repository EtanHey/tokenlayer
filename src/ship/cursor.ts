import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { projectFromCwd, type FileState } from "./parse";
import { parseTimestampMs, toClickHouseTime } from "../lib/time";

/** Cursor's project directory encoding is lossy. Prefer exact registry paths over decoding. */
export const cursorEncode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-/, "");
export function cursorWorkspaces(path?: string): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  if (!path || !existsSync(path)) return new Map();
  const db = new Database(path, { readonly: true });
  try {
    const has = (name: string) => !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const paths: string[] = [];
    if (has("projection_projects")) paths.push(...db.query<{ cwd: string }, []>("SELECT workspace_root AS cwd FROM projection_projects").all().map(r => r.cwd));
    if (has("orchestration_v2_projection_threads")) paths.push(...db.query<{ cwd: string }, []>("SELECT json_extract(payload_json, '$.worktreePath') AS cwd FROM orchestration_v2_projection_threads WHERE json_valid(payload_json)").all().map(r => r.cwd));
    for (const cwd of paths) if (typeof cwd === "string" && cwd.startsWith("/")) {
      const key = cursorEncode(cwd), values = candidates.get(key) ?? new Set<string>();
      values.add(cwd); candidates.set(key, values);
    }
  } finally { db.close(); }
  // Never choose arbitrarily when two real paths share the same encoding.
  return new Map([...candidates].map(([key, paths]) => [key, paths.size === 1 ? [...paths][0] : ""]));
}

export function cursorIdentity(root: string, path: string, workspaces = new Map<string, string>()) {
  const match = /^([^/]+)\/agent-transcripts\/([^/]+)\/([^/]+)\.jsonl$/.exec(relative(root, path));
  if (!match || match[2] !== match[3]) return null;
  const encoded = match[1];
  // Only recover a conventional repository root; nested paths need the registry.
  const conventional = /^Users-([^-]+)-Gits-(.+)$/.exec(encoded);
  const [, USER, REPO] = conventional ?? [];
  const cwd = workspaces.has(encoded) ? workspaces.get(encoded)! : conventional ? `/Users/${USER}/Gits/${REPO}` : "";
  return { sessionId: match[2], cwd };
}

/** Inspect metadata only. raw remains the untouched line, like Claude/Codex/Kiro. */
export function parseCursor(line: string, state: FileState) {
  let o: Record<string, unknown> = {};
  let valid = false;
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value)) { o = value as Record<string, unknown>; valid = true; }
  } catch {}
  const role = o.role === "user" || o.role === "assistant" ? o.role : "";
  return { ts: toClickHouseTime(parseTimestampMs(o.timestamp) ?? 0), session_id: state.sessionId, session_alias: "",
    project: projectFromCwd(state.cwd), cwd: state.cwd, type: valid ? "cursor:message" : "invalid", role,
    model: null, message_id: "", input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null, reasoning_tokens: null, raw: line };
}
