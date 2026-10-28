import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClickHouse } from "../../src/lib/clickhouse";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";

type Row = Record<string, unknown>;

function fakeClickHouse() {
  const rows: Row[] = [];
  const tokens: string[] = [];
  let fail = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      if (fail) return new Response("down", { status: 503 });
      tokens.push(url.searchParams.get("insert_deduplication_token") ?? "");
      for (const l of body.split("\n")) if (l) rows.push(JSON.parse(l));
      return new Response("");
    },
  });
  return {
    server,
    rows,
    tokens,
    setFail: (v: boolean) => (fail = v),
    client: new ClickHouse({ url: `http://127.0.0.1:${server.port}`, user: "u", password: "p", database: "tokenlayer" }),
  };
}

const claudeLine = (i: number, entrypoint = "cli") =>
  JSON.stringify({ type: "user", sessionId: "s-1", cwd: "/Users/u/Gits/golems", entrypoint, timestamp: `2026-10-28T08:00:0${i}.000Z`, message: { role: "user", content: `m${i}` } });
const codexMeta = (originator: string) =>
  JSON.stringify({ timestamp: "2026-10-28T08:00:00.000Z", type: "session_meta", payload: { id: "c-1", cwd: "/Users/u/Gits/brainlayer", originator } });

let root: string;
let db: ReturnType<typeof fakeClickHouse>;
let opts: ShipOptions;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tokenlayer-ship-"));
  mkdirSync(join(root, "claude", "-Users-u-Gits-golems", "s-1", "subagents"), { recursive: true });
  mkdirSync(join(root, "codex", "2026", "10", "28"), { recursive: true });
  db = fakeClickHouse();
  opts = {
    machine: "m4",
    roots: [
      { kind: "claude", dir: join(root, "claude") },
      { kind: "codex", dir: join(root, "codex") },
    ],
    clickhouse: db.client,
    statePath: join(root, "state", "ship-state.json"),
    rateBytesPerSec: 0,
  };
});
afterEach(() => {
  db.server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const claudeFile = () => join(root, "claude", "-Users-u-Gits-golems", "s-1.jsonl");
const codexFile = () => join(root, "codex", "2026", "10", "28", "rollout-a.jsonl");

describe("shipOnce", () => {
  test("ships complete lines from both roots with machine, harness, path and byte offset", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n${claudeLine(2)}\n{"partial":`);
    writeFileSync(join(root, "claude", "-Users-u-Gits-golems", "s-1", "subagents", "agent-x.jsonl"), `${claudeLine(3, "sdk-ts")}\n`);
    writeFileSync(codexFile(), `${codexMeta("T3 Code")}\n`);
    writeFileSync(join(root, "claude", "-Users-u-Gits-golems", "notes.md"), "ignored\n");

    const r = await shipOnce(opts);
    expect(r.lines).toBe(4);
    const byPath = Object.fromEntries(db.rows.map((row) => [`${row.path}@${row.byte_offset}`, row]));
    expect(byPath[`${claudeFile()}@0`]).toMatchObject({ machine: "m4", harness: "claude", session_id: "s-1", project: "golems" });
    expect(byPath[`${claudeFile()}@${claudeLine(1).length + 1}`]).toBeDefined();
    const sub = db.rows.find((row) => String(row.path).includes("agent-x"));
    expect(sub?.harness).toBe("t3");
    const cx = db.rows.find((row) => row.path === codexFile());
    expect(cx).toMatchObject({ harness: "t3", session_id: "c-1", project: "brainlayer", line_bytes: codexMeta("T3 Code").length + 1 });
    expect(db.rows.some((row) => String(row.raw).includes("partial"))).toBe(false);
    expect(existsSync(opts.statePath)).toBe(true);
  });

  test("a re-run with the checkpoint inserts nothing", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    await shipOnce(opts);
    const before = db.rows.length;
    const again = await shipOnce(opts);
    expect(again.lines).toBe(0);
    expect(db.rows.length).toBe(before);
  });

  test("a completed partial line is shipped at its original offset, once", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n{"type":"user",`);
    await shipOnce(opts);
    appendFileSync(claudeFile(), `"sessionId":"s-1"}\n`);
    await shipOnce(opts);
    expect(db.rows.map((r) => r.byte_offset)).toEqual([0, claudeLine(1).length + 1]);
  });

  test("truncation restarts the file from offset 0", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n${claudeLine(2)}\n`);
    await shipOnce(opts);
    writeFileSync(claudeFile(), `${claudeLine(5)}\n`);
    const r = await shipOnce(opts);
    expect(r.lines).toBe(1);
    expect(db.rows.at(-1)).toMatchObject({ byte_offset: 0 });
    expect(String(db.rows.at(-1)!.raw)).toContain("m5");
  });

  test("rotation (new inode or rewritten head) restarts the file from offset 0", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    await shipOnce(opts);
    const tmp = `${claudeFile()}.new`;
    writeFileSync(tmp, `${claudeLine(7)}\n${claudeLine(8)}\n`);
    renameSync(tmp, claudeFile());
    const r = await shipOnce(opts);
    expect(r.lines).toBe(2);
    expect(String(db.rows.find((row) => row.byte_offset === 0 && String(row.raw).includes("m7"))?.raw)).toContain("m7");
  });

  test("files untouched since --since and without a checkpoint are skipped", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(claudeFile(), old, old);
    writeFileSync(codexFile(), `${codexMeta("codex_exec")}\n`);
    const r = await shipOnce({ ...opts, sinceMs: Date.parse("2026-10-01T00:00:00Z") });
    expect(r.lines).toBe(1);
    expect(db.rows[0].harness).toBe("codex");
  });

  test("an insert failure does not advance the checkpoint; the retry reuses the dedup token", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    db.setFail(true);
    await expect(shipOnce(opts)).rejects.toThrow();
    db.setFail(false);
    const r = await shipOnce(opts);
    expect(r.lines).toBe(1);
    expect(db.rows).toHaveLength(1);
    const token = db.tokens[0];
    rmSync(opts.statePath);
    await shipOnce(opts);
    expect(db.tokens[1]).toBe(token);
  });

  test("throughput cap paces the backfill", async () => {
    writeFileSync(claudeFile(), `${Array.from({ length: 40 }, (_, i) => claudeLine(i % 10)).join("\n")}\n`);
    const t0 = performance.now();
    const r = await shipOnce({ ...opts, rateBytesPerSec: 20_000, batchBytes: 2000 });
    const elapsed = (performance.now() - t0) / 1000;
    expect(r.bytes).toBeGreaterThan(5000);
    expect(elapsed).toBeGreaterThanOrEqual((r.bytes - 2000) / 20_000 - 0.05);
  });

  test("a file whose harness is decided late is reshipped so all its rows agree", async () => {
    const queueOp = JSON.stringify({ type: "queue-operation", sessionId: "s-1", timestamp: "2026-10-28T08:00:00Z" });
    writeFileSync(claudeFile(), `${queueOp}\n`);
    await shipOnce(opts);
    expect(db.rows[0].harness).toBe("claude");
    appendFileSync(claudeFile(), `${claudeLine(2, "sdk-ts")}\n`);
    const r = await shipOnce(opts);
    expect(r.resets).toBe(1);
    expect(db.rows.slice(1).map((row) => [row.byte_offset, row.harness])).toEqual([
      [0, "t3"],
      [queueOp.length + 1, "t3"],
    ]);
  });

  test("a reshipped chunk with changed rows gets a new dedup token; an identical retry keeps it", async () => {
    const queueOp = JSON.stringify({ type: "queue-operation", sessionId: "s-1", timestamp: "2026-10-28T08:00:00Z" });
    writeFileSync(claudeFile(), `${queueOp}\n`);
    await shipOnce({ ...opts, batchBytes: 1 });
    const first = db.tokens[0];
    appendFileSync(claudeFile(), `${claudeLine(2, "sdk-ts")}\n`);
    await shipOnce({ ...opts, batchBytes: 1 });
    // Same file, same first-chunk range [0, len), but the rows now say t3: the server must not drop it as a retry.
    expect(db.rows[1]).toMatchObject({ byte_offset: 0, harness: "t3" });
    expect(db.tokens[1]).not.toBe(first);
    rmSync(opts.statePath);
    await shipOnce({ ...opts, batchBytes: 1 });
    expect(db.tokens.slice(3, 5)).toEqual(db.tokens.slice(1, 3));
  });

  test("an equal-size in-place rewrite of a completed file is detected and reshipped", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    await shipOnce(opts);
    expect(claudeLine(2).length).toBe(claudeLine(1).length);
    writeFileSync(claudeFile(), `${claudeLine(2)}\n`);
    const r = await shipOnce(opts);
    expect(r).toMatchObject({ files: 1, lines: 1, resets: 1 });
    expect(String(db.rows.at(-1)!.raw)).toContain("m2");
  });

  test("an untouched completed file is skipped without re-reading it", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    await shipOnce(opts);
    const r = await shipOnce(opts);
    expect(r).toEqual({ files: 0, lines: 0, bytes: 0, resets: 0 });
  });

  test("rows carry a generation: stable across checkpoint loss, new for a different file at the same path", async () => {
    writeFileSync(claudeFile(), `${claudeLine(1)}\n`);
    await shipOnce(opts);
    const gen = db.rows[0].generation;
    expect(gen).toMatch(/^[0-9a-f]{16}$/);
    rmSync(opts.statePath);
    await shipOnce(opts);
    expect(db.rows[1].generation).toBe(gen);
    renameSync(claudeFile(), `${claudeFile()}.bak`);
    writeFileSync(claudeFile(), `${claudeLine(7)}\n`);
    await shipOnce(opts);
    expect(db.rows[2].generation).not.toBe(gen);
  });

  test("raw and parsed columns never carry credentials or emails", async () => {
    const key = "sk-ant-api03-FAKEfakeFAKEfake0123456789";
    const email = "erin.fake@example.invalid";
    const authFile = JSON.stringify({ type: "claude", email, access_token: "sk-ant-oat01-FAKEfakeFAKE0123456789", refresh_token: "opaque-refresh-fake" });
    const toolResult = JSON.stringify({
      type: "user",
      sessionId: "s-1",
      cwd: "/Users/u/Gits/golems",
      entrypoint: "cli",
      timestamp: "2026-10-28T08:00:01Z",
      message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: `$ cat auth.json\n${authFile}\nexport ANTHROPIC_API_KEY=${key}` }] }] },
    });
    writeFileSync(claudeFile(), `${toolResult}\n{"broken": "Authorization: Bearer fakeBearer0123456789abcdef ${email}\n`);
    await shipOnce(opts);
    expect(db.rows).toHaveLength(2);
    const all = JSON.stringify(db.rows);
    for (const secret of [key, email, "sk-ant-oat01-FAKEfakeFAKE0123456789", "opaque-refresh-fake", "fakeBearer0123456789abcdef"]) {
      expect(all).not.toContain(secret);
    }
    expect(db.rows[0]).toMatchObject({ session_id: "s-1", project: "golems", type: "user" });
  });
});
