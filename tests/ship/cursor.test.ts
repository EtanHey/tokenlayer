import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cursorEncode, cursorIdentity } from "../../src/ship/cursor";
import { ClickHouse } from "../../src/lib/clickhouse";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";
import { loadState } from "../../src/ship/state";

const USER = "example";
function registryAt(path: string, cwd: string) {
  const db = new Database(path);
  db.run("CREATE TABLE projection_projects (workspace_root TEXT)");
  db.run("INSERT INTO projection_projects VALUES (?)", [cwd]);
  db.close();
  return path;
}
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("Cursor native discovery ships exact bytes, path attribution and unknown usage; skips unrelated JSONL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-ship-")); dirs.push(dir);
  const root = join(dir, "projects");
  const session = "agent-synthetic-session";
  const folder = join(root, "Users-example-Gits-dialogkit", "agent-transcripts", session);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${session}.jsonl`);
  const raw = readFileSync(join(import.meta.dir, "../fixtures/cursor/native.jsonl"), "utf8");
  writeFileSync(path, raw);
  writeFileSync(join(root, "index.jsonl"), raw);
  const rows: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    rows.push(...(await req.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    return new Response("");
  } });
  const opts: ShipOptions = { machine: "synthetic", roots: [{ kind: "cursor", dir: root }], statePath: join(dir, "state.json"),
    cursorT3StatePath: registryAt(join(dir, "t3.sqlite"), `/Users/${USER}/Gits/dialogkit`),
    rateBytesPerSec: 0, clickhouse: new ClickHouse({ url: server.url.toString(), user: "default", password: "", database: "tokenlayer" }) };
  try {
    expect((await shipOnce(opts)).lines).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.role)).toEqual(["user", "assistant"]);
    expect(rows.map(r => r.raw).join("")).toBe(raw);
    for (const row of rows) {
      expect(row.harness).toBe("cursor"); expect(row.session_id).toBe(session);
      expect(row.project).toBe("dialogkit"); expect(row.cwd).toBe(`/Users/${USER}/Gits/dialogkit`);
      for (const key of ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens"]) expect(row[key]).toBeNull();
      expect(row.ts).toBe("1970-01-01 00:00:00.000");
    }
    expect((await shipOnce(opts)).lines).toBe(0);
    rows.length = 0;
    writeFileSync(path, JSON.stringify({ role: "user", timestamp: new Date(Date.now() - 40 * 86400000).toISOString(), message: { content: [] } }) + "\n");
    await shipOnce(opts);
    expect(rows).toHaveLength(0);
    expect(loadState(opts.statePath).files[path].offset).toBe(Buffer.byteLength(readFileSync(path)));
  } finally { server.stop(true); }
});

test("Cursor resolves hyphens and worktrees from registry paths without inspecting message text", async () => {
  const { Database } = await import("bun:sqlite");
  const { cursorWorkspaces, cursorIdentity, parseCursor } = await import("../../src/ship/cursor");
  const { newFileState } = await import("../../src/ship/parse");
  const dir = mkdtempSync(join(tmpdir(), "cursor-registry-")); dirs.push(dir);
  const path = join(dir, "t3.sqlite"), db = new Database(path);
  db.run("CREATE TABLE projection_projects (workspace_root TEXT)");
  db.run("CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT)");
  db.run("INSERT INTO projection_projects VALUES (?)", [`/Users/${USER}/Gits/demo-app`]);
  db.run("INSERT INTO orchestration_v2_projection_threads VALUES (?)", [JSON.stringify({ worktreePath: `/Users/${USER}/.t3/worktrees/dialogkit/worker-one` })]);
  db.close();
  const registry = cursorWorkspaces(path);
  expect(cursorIdentity("/projects", "/projects/Users-example-Gits-demo-app/agent-transcripts/id/id.jsonl", registry)?.cwd).toBe(`/Users/${USER}/Gits/demo-app`);
  expect(cursorIdentity("/projects", "/projects/Users-example--t3-worktrees-dialogkit-worker-one/agent-transcripts/id/id.jsonl", registry)?.cwd).toBe(`/Users/${USER}/.t3/worktrees/dialogkit/worker-one`);
  expect(cursorIdentity("/projects", "/projects/Users-example-Gits-dialogkit/agent-transcripts/id/other.jsonl", registry)).toBeNull();
  expect(cursorWorkspaces(join(dir, "absent.sqlite")).size).toBe(0);
  const state = newFileState("cursor", "cursor", Date.now());
  const raw = JSON.stringify({ role: "assistant", model: "default", usagePercentage: 99, message: { content: [] } });
  expect(parseCursor(raw, state).model).toBeNull();
  expect(parseCursor(raw, state).input_tokens).toBeNull();
  expect(parseCursor("not-json", state).type).toBe("invalid");
});


test("lossy Cursor directory names stay unknown without exact registry evidence", () => {
  for (const cwd of [`/Users/${USER}/Gits/dialogkit/packages/ui`, `/Users/${USER}/Gits/demo-app`, `/Users/${USER}/Gits/demo.app`, `/Users/${USER}/Gits/demo_app`, `/Users/${USER}/Gits/dialogkit`]) {
    const encoded = cursorEncode(cwd);
    const path = `/projects/${encoded}/agent-transcripts/id/id.jsonl`;
    expect(cursorIdentity("/projects", path)?.cwd).toBe("");
    expect(cursorIdentity("/projects", path, new Map([[encoded, cwd]]))?.cwd).toBe(cwd);
    expect(cursorIdentity("/projects", path, new Map([[encoded, ""]]))?.cwd).toBe("");
  }
});

test("broken optional Cursor registry does not stop any ship source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-isolation-")); dirs.push(dir);
  const root = join(dir, "projects"), claude = join(dir, "claude");
  const folder = join(root, "Users-example-Gits-demo-app/agent-transcripts/id");
  mkdirSync(folder, { recursive: true }); mkdirSync(claude);
  writeFileSync(join(folder, "id.jsonl"), '{"role":"user"}\n');
  writeFileSync(join(claude, "session.jsonl"), '{"type":"user","sessionId":"claude-fixture","message":{"role":"user","content":[]}}\n');
  const codex = join(dir, "codex"), kiro = join(dir, "kiro"), agy = join(dir, "agy"), t3agy = join(dir, "t3agy");
  const extra = [
    [join(codex, "session.jsonl"), '{"type":"session_meta","payload":{"id":"codex-fixture"}}\n'],
    [join(kiro, "workspace/session/messages.jsonl"), '{"payload":{"type":"user"}}\n'],
    [join(agy, "session/.system_generated/logs/transcript.jsonl"), JSON.stringify({ created_at: new Date().toISOString() }) + "\n"],
    [join(t3agy, "profile/antigravity-acp/brain/session/.system_generated/logs/transcript.jsonl"), JSON.stringify({ created_at: new Date().toISOString() }) + "\n"],
  ];
  for (const [path, raw] of extra) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, raw); }
  const registry = join(dir, "bad.sqlite"); writeFileSync(registry, "not a database");
  const rows: Record<string, unknown>[] = [], logs: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    rows.push(...(await req.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    return new Response("");
  } });
  try {
    const result = await shipOnce({ machine: "synthetic", roots: [{ kind: "cursor", dir: root }, { kind: "claude", dir: claude }, { kind: "codex", dir: codex }, { kind: "kiro", dir: kiro }, { kind: "antigravity-cli", dir: agy }, { kind: "t3-antigravity", dir: t3agy }],
      statePath: join(dir, "state.json"), cursorT3StatePath: registry, rateBytesPerSec: 0, log: line => logs.push(line),
      clickhouse: new ClickHouse({ url: server.url.toString(), user: "default", password: "", database: "tokenlayer" }) });
    expect(result.lines).toBe(6);
    expect(rows.map(row => row.harness)).toEqual(["cursor", "claude", "codex", "kiro", "antigravity", "t3"]);
    expect(rows[0].cwd).toBe(""); expect(rows[0].project).toBe("");
    expect(logs.filter(line => line.includes("Cursor workspace registry unavailable"))).toHaveLength(1);
  } finally { server.stop(true); }
});


test("Cursor append failure, checkpoint loss and registry correction preserve acknowledged identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-recovery-")); dirs.push(dir);
  const root = join(dir, "projects"), cwd = `/Users/${USER}/Gits/demo-app`;
  const folder = join(root, cursorEncode(cwd), "agent-transcripts/id");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "id.jsonl"), head = '{"role":"user"}\n', tail = '{"role":"assistant"}\n';
  writeFileSync(path, head);
  const registry = join(dir, "t3.sqlite"), statePath = join(dir, "state.json");
  const rows: Record<string, unknown>[] = [];
  let fail = false;
  const server = Bun.serve({ port: 0, async fetch(req) {
    if (fail) return new Response("fixture failure", { status: 500 });
    rows.push(...(await req.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    return new Response("");
  } });
  const opts: ShipOptions = { machine: "synthetic", roots: [{ kind: "cursor", dir: root }], statePath,
    cursorT3StatePath: registry, rateBytesPerSec: 0,
    clickhouse: new ClickHouse({ url: server.url.toString(), user: "default", password: "", database: "tokenlayer" }) };
  try {
    expect((await shipOnce(opts)).lines).toBe(1);
    const generation = rows[0].generation;
    appendFileSync(path, tail); fail = true;
    await expect(shipOnce(opts)).rejects.toThrow();
    expect(loadState(statePath).files[path].offset).toBe(Buffer.byteLength(head));
    expect(loadState(`${statePath}.generations`).files[path].offset).toBeGreaterThan(Buffer.byteLength(head));
    fail = false;
    expect(await shipOnce(opts)).toMatchObject({ lines: 1, resets: 0 });
    expect(rows[1].byte_offset).toBe(Buffer.byteLength(head));
    expect(rows[1].generation).toBe(generation);
    rmSync(statePath);
    expect((await shipOnce(opts)).lines).toBe(2);
    expect(rows.slice(-2).map(row => row.generation)).toEqual([generation, generation]);
    registryAt(registry, cwd);
    // A newly resolved cwd must replace all rows under the same native keys,
    // even when bytes and mtime did not change and the journal survived.
    expect(await shipOnce(opts)).toMatchObject({ lines: 2, resets: 1 });
    expect(rows.slice(-2).map(row => [row.cwd, row.project, row.generation])).toEqual([[cwd, "demo-app", generation], [cwd, "demo-app", generation]]);
    expect(rows.slice(-2).map(row => row.raw).join("")).toBe(head + tail);
    expect((await shipOnce(opts)).lines).toBe(0);
  } finally { server.stop(true); }
});
