import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClickHouse } from "../../src/lib/clickhouse";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";
import { loadState } from "../../src/ship/state";

const USER = "example";
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
