import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { antigravityCwd, parseAntigravity } from "../../src/ship/antigravity";
import { newFileState, projectFromCwd } from "../../src/ship/parse";
import { ClickHouse } from "../../src/lib/clickhouse";
import { shipOnce } from "../../src/ship/ship";

const home = join("/", "Users", "u");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agy-attribution-")); dirs.push(dir);
  const root = join(dir, "userdata/providers/antigravity");
  const path = join(root, "hash/antigravity-acp/brain/native/.system_generated/logs/transcript.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  // Native .db exists, .meta does not. Opaque conversation contents must never be read.
  const conversations = join(root, "hash/antigravity-acp/conversations");
  mkdirSync(conversations); writeFileSync(join(conversations, "native.db"), "opaque, not sqlite");
  const db = new Database(join(dir, "userdata/statev2.sqlite"));
  db.run("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, payload_json TEXT)");
  db.run("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT)");
  db.run("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)");
  db.run("INSERT INTO projection_projects VALUES ('project', ?)", [`${home}/Gits/audio-dashboard`]);
  const bind = (thread = "thread", worktree: string | null = null, driver = "antigravity", native = "native") => {
    db.run("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)", [thread, driver, JSON.stringify({ nativeThreadRef: { nativeId: native } })]);
    db.run("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'project', ?)", [thread, JSON.stringify({ worktreePath: worktree })]);
  };
  return { dir, root, path, db, bind };
}
const line = (model?: unknown) => JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-20T04:06:08Z", model, input_tokens: 10, output_tokens: 3, cache_read_tokens: 5 }) + "\n";

test("native models stay record-local, including worker, Neon and Hydrogen; absent/invalid stays unknown", () => {
  const state = newFileState("t3-antigravity", "t3", 0); state.model = "selected-parent";
  for (const model of ["gemini-4-neon-high", "gemini-pro-orchestrator-neon", "gemini-flash-worker-agy", "gemini-4-hydrogen-low", undefined, 7]) {
    expect(parseAntigravity(line(model), state)).toMatchObject({ model: typeof model === "string" ? model : "", input_tokens: 10, output_tokens: 3, cache_read_tokens: 5 });
  }
});

test("absent meta joins native id to project root and worktree metadata only", () => {
  const f = fixture();
  try {
    f.bind("unrelated", `${home}/Gits/wrong`, "codex");
    f.bind("other-native", `${home}/Gits/wrong`, "antigravity", "other");
    f.bind();
    expect(antigravityCwd(f.root, f.path, "native", "t3-antigravity")).toBe(`${home}/Gits/audio-dashboard`);
    const worktree = `${home}/.t3/worktrees/audio-dashboard/author`;
    f.db.run("UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = 'thread'", [JSON.stringify({ worktreePath: worktree })]);
    const cwd = antigravityCwd(f.root, f.path, "native", "t3-antigravity");
    expect(cwd).toBe(worktree); expect(projectFromCwd(cwd)).toBe("audio-dashboard");
    expect(antigravityCwd(f.root, f.path, "missing", "t3-antigravity")).toBe("");
    f.bind("conflict", `${home}/Gits/conflict`);
    expect(antigravityCwd(f.root, f.path, "native", "t3-antigravity")).toBe("");
  } finally { f.db.close(); }
});

test("meta takes precedence and missing/unavailable registry fails closed", () => {
  const f = fixture(); f.db.close();
  rmSync(join(f.dir, "userdata/statev2.sqlite"));
  expect(antigravityCwd(f.root, f.path, "native", "t3-antigravity")).toBe("");
  writeFileSync(join(f.dir, "userdata/statev2.sqlite"), "unavailable sqlite");
  expect(antigravityCwd(f.root, f.path, "native", "t3-antigravity")).toBe("");
  writeFileSync(join(f.root, "hash/antigravity-acp/conversations/native.meta"), JSON.stringify({ cwd: `${home}/Gits/skill-creator` }));
  expect(antigravityCwd(f.root, f.path, "native", "t3-antigravity")).toBe(`${home}/Gits/skill-creator`);
});

test("existing blank checkpoint attributes only appended lines without replay", async () => {
  const f = fixture();
  const rows: Record<string, unknown>[] = [];
  const client = new ClickHouse({ url: "http://unused.invalid", user: "fixture", password: "", database: "tokenlayer" });
  client.insert = async (_table, batch) => { rows.push(...batch as Record<string, unknown>[]); };
  const opts = { machine: "fixture", roots: [{ kind: "t3-antigravity" as const, dir: f.root }], clickhouse: client, statePath: join(f.dir, "state.json"), rateBytesPerSec: 0 };
  try {
    writeFileSync(f.path, line());
    expect((await shipOnce(opts)).lines).toBe(1);
    expect(rows[0]).toMatchObject({ cwd: "", project: "", model: "" });
    f.bind();
    appendFileSync(f.path, line("gemini-pro-orchestrator-neon") + line("gemini-flash-worker-agy"));
    expect(await shipOnce(opts)).toMatchObject({ lines: 2, resets: 0 });
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).map(r => [r.cwd, r.project, r.model])).toEqual([
      [`${home}/Gits/audio-dashboard`, "audio-dashboard", "gemini-pro-orchestrator-neon"],
      [`${home}/Gits/audio-dashboard`, "audio-dashboard", "gemini-flash-worker-agy"],
    ]);
    expect((await shipOnce(opts)).lines).toBe(0);
  } finally { f.db.close(); }
});
