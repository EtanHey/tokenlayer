import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";

let ch: LocalClickHouse, dir: string, cli: string, t3: string, opts: ShipOptions;
const line = (created_at?: string) => JSON.stringify({ step_index: 0, type: "user", source: "user", status: "done", ...(created_at ? { created_at } : {}), content: "synthetic fixture" }) + "\r\n";
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
beforeAll(async () => {
  ch = await startLocalClickHouse();
  await applySchema(ch.client);
  dir = mkdtempSync(join(import.meta.dir, "../../.local/agy-it-"));
  cli = join(dir, "cli/brain/native-cli/.system_generated/logs/transcript.jsonl");
  t3 = join(dir, "t3/hash/antigravity-acp/brain/native-t3/.system_generated/logs/transcript.jsonl");
  put(cli, line("2026-10-28T08:00:00.123456Z") + line());
  put(t3, line("2026-10-29T09:00:00Z"));
  put(join(dir, "t3/hash/antigravity-acp/conversations/native-t3.meta"), JSON.stringify({ cwd: "/Users/u/.t3/worktrees/brainlayer/topic", mode_id: "not-a-model" }));
  put(join(dir, "t3/hash/antigravity-acp/copied-fixture.jsonl"), line("2026-10-29T00:00:00Z"));
  const db = new Database(join(dir, "cli/conversation_summaries.db"));
  db.run("CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, raw_summary BLOB)");
  db.run("INSERT INTO conversation_summaries VALUES (?, ?, ?)", ["native-cli", JSON.stringify(["file:///Users/u/Gits/tokenlayer/.local/wt-synthetic"]), null]);
  db.close();
  opts = { machine: "fixture", roots: [{ kind: "antigravity-cli", dir: join(dir, "cli/brain") }, { kind: "t3-antigravity", dir: join(dir, "t3") }], clickhouse: ch.client, statePath: join(dir, "state.json"), rateBytesPerSec: 0, batchBytes: 1 };
}, 40000);
afterAll(async () => { await ch?.stop(); });

test("Antigravity native ids, UTC times, joined cwd, empty model and daily harness/repo", async () => {
  expect((await shipOnce(opts)).lines).toBe(3);
  const rows = await ch.client.queryJSON("SELECT session_id, harness, project, model, ts FROM tokenlayer.session_events FINAL ORDER BY path, byte_offset");
  expect(rows).toEqual([
    { session_id: "native-cli", harness: "antigravity", project: "tokenlayer", model: "", ts: "2026-10-28 08:00:00.123" },
    { session_id: "native-cli", harness: "antigravity", project: "tokenlayer", model: "", ts: "2026-10-28 08:00:00.123" },
    { session_id: "native-t3", harness: "t3", project: "brainlayer", model: "", ts: "2026-10-29 09:00:00.000" },
  ]);
  expect(await ch.client.queryJSON("SELECT repo, model, harness, sessions FROM tokenlayer.v_sessions_daily ORDER BY repo")).toEqual([
    { repo: "brainlayer", model: "(none)", harness: "t3", sessions: 1 },
    { repo: "tokenlayer", model: "(none)", harness: "antigravity", sessions: 1 },
  ]);
  const raw = await ch.client.queryJSON<{ bytes: string }>("SELECT hex(raw) AS bytes FROM tokenlayer.session_events FINAL ORDER BY path, byte_offset");
  expect(raw.map(r => r.bytes)).toEqual([line("2026-10-28T08:00:00.123456Z"), line(), line("2026-10-29T09:00:00Z")].map(s => Buffer.from(s).toString("hex").toUpperCase()));
});

test("Antigravity append, checkpoint loss and rewrite keep native session counts stable", async () => {
  expect((await shipOnce(opts)).lines).toBe(0);
  appendFileSync(cli, line()); // Carry the prior timestamp across persisted checkpoints.
  expect((await shipOnce(opts)).lines).toBe(1);
  unlinkSync(opts.statePath);
  expect((await shipOnce(opts)).lines).toBe(4);
  const before = await ch.client.queryJSON("SELECT count() AS n FROM tokenlayer.session_events FINAL");
  expect(before).toEqual([{ n: 4 }]);
  writeFileSync(cli, readFileSync(cli, "utf8").replace("08:00:00", "10:00:00"));
  expect((await shipOnce(opts)).resets).toBe(1);
  expect((await shipOnce(opts)).lines).toBe(0);
  expect(await ch.client.queryJSON("SELECT sum(sessions) AS n FROM tokenlayer.v_sessions_daily")).toEqual([{ n: 2 }]);
});
