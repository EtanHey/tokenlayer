import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClickHouse } from "../../src/lib/clickhouse";
import { applySchema } from "../../src/lib/schema";
import { startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";

// Shape from one native Auto turn and one T3 Auto turn on 2026-11-03; values are invented.
const line = (type: string, extra = {}, timestamp = "2026-11-03T03:00:00Z") =>
  JSON.stringify({ timestamp, payload: { type, ...extra } }) + "\r\n";
const summary = (usage: number, turnId = "turn-1") => line("usage_summary", {
  executionId: "execution-1", turnId, status: "success", elapsedTime: 1000,
  promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage }], requestIds: ["request-1"],
});

test("Kiro native capture: metadata, fractional credits, late T3 attribution and replay", async () => {
  const ch = await startLocalClickHouse();
  const dir = mkdtempSync(join(import.meta.dir, "../../.local/kiro-it-"));
  try {
    await applySchema(ch.client);
    const session = join(dir, "sessions/workspace/sess-native");
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "session.json"), JSON.stringify({ id: "sess-native", modelId: "auto",
      workspacePaths: ["/Users/test/Gits/tokenlayer"], rootPaths: ["/Users/test/Gits/tokenlayer"] }));
    const path = join(session, "messages.jsonl");
    const bytes = line("user", { content: "Authorization: Bearer SYNTHETICarchiveToken0123456789" }) + summary(0.125);
    writeFileSync(path, bytes);
    // Indexes and unrelated JSONL must not be shipped.
    writeFileSync(join(dir, "sessions/index.jsonl"), line("user"));
    const t3db = join(dir, "t3.sqlite");
    const opts: ShipOptions = { machine: "fixture", roots: [{ kind: "kiro", dir: join(dir, "sessions") }],
      kiroT3StatePath: t3db, clickhouse: ch.client, statePath: join(dir, "state.json"), batchBytes: 1, rateBytesPerSec: 0 };
    expect((await shipOnce(opts)).lines).toBe(2);
    expect(await ch.client.queryJSON("SELECT DISTINCT harness, session_id, cwd, model FROM tokenlayer.session_events FINAL")).toEqual([
      { harness: "kiro", session_id: "sess-native", cwd: "/Users/test/Gits/tokenlayer", model: "auto" },
    ]);
    expect(await ch.client.queryJSON("SELECT credits, input_tokens FROM tokenlayer.session_events FINAL ORDER BY byte_offset")).toEqual([
      { credits: null, input_tokens: 0 }, { credits: 0.125, input_tokens: 0 },
    ]);
    expect(await ch.client.queryJSON("SELECT hex(raw) AS raw FROM tokenlayer.session_events FINAL ORDER BY byte_offset")).toEqual(
      [line("user", { content: "Authorization: Bearer SYNTHETICarchiveToken0123456789" }), summary(0.125)].map(raw => ({ raw: Buffer.from(raw).toString("hex").toUpperCase() })),
    );
    const db = new Database(t3db);
    db.run("CREATE TABLE orchestration_v2_projection_provider_threads (driver TEXT, payload_json TEXT)");
    db.run("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)", ["kiro", JSON.stringify({ nativeThreadRef: { nativeId: "sess-native" } })]);
    db.close();
    // Interrupt a late-harness replay while its generation journal still protects the old prefix.
    const interrupted = new ClickHouse(ch.client.config);
    let inserts = 0;
    interrupted.insert = async (...args) => {
      if (++inserts === 2) throw new Error("synthetic interrupted replay");
      await ch.client.insert(...args);
    };
    await expect(shipOnce({ ...opts, clickhouse: interrupted })).rejects.toThrow("ship failed");
    expect((await shipOnce(opts)).lines).toBe(2); // Resume with no skipped prefix or duplicate credit.
    expect(await ch.client.queryJSON("SELECT DISTINCT harness FROM tokenlayer.session_events FINAL")).toEqual([{ harness: "t3" }]);
    appendFileSync(path, summary(0.25, "turn-2"));
    expect((await shipOnce(opts)).lines).toBe(1);
    unlinkSync(opts.statePath);
    expect((await shipOnce(opts)).lines).toBe(3);
    expect(await ch.client.queryJSON("SELECT sum(credits) AS credits FROM tokenlayer.session_events FINAL")).toEqual([{ credits: 0.375 }]);
    await applySchema(ch.client); // Additive migration is repeatable.
    expect((await shipOnce(opts)).lines).toBe(0);
    // Keep revision data available for the comparison-view deduplication test.
    writeFileSync(path, readFileSync(path, "utf8").replace('"usage":0.125', '"usage":0.5'));
    expect((await shipOnce(opts)).resets).toBe(1);
    expect(await ch.client.queryJSON("SELECT credits_used FROM tokenlayer.v_provider_usage_compare WHERE provider = 'kiro'")).toEqual([{ credits_used: 0.75 }]);
  } finally { await ch.stop(); }
}, 40000);


test("Kiro later summary in one insert wins over the earlier line's larger hash", async () => {
  const ch = await startLocalClickHouse();
  const dir = mkdtempSync(join(import.meta.dir, "../../.local/kiro-order-"));
  try {
    await applySchema(ch.client);
    const session = join(dir, "sessions/workspace/native");
    mkdirSync(session, { recursive: true });
    // These real line hashes sort in reverse source order (609c... then 59f3...).
    writeFileSync(join(session, "messages.jsonl"), summary(0.125) + summary(0.25));
    await shipOnce({ machine: "fixture", roots: [{ kind: "kiro", dir: join(dir, "sessions") }],
      statePath: join(dir, "state.json"), clickhouse: ch.client, rateBytesPerSec: 0 });
    expect(await ch.client.queryJSON("SELECT uniqExact(ingested_at) AS inserts FROM tokenlayer.session_events")).toEqual([{ inserts: 1 }]);
    expect(await ch.client.queryJSON("SELECT credits_used FROM tokenlayer.v_provider_usage_compare WHERE provider = 'kiro'")).toEqual([{ credits_used: 0.25 }]);
  } finally { await ch.stop(); }
}, 40000);

for (const mode of ["torn", "deleted"]) test(`Kiro ${mode} session metadata keeps the last known cwd/model while shipping`, async () => {
  const ch = await startLocalClickHouse();
  const dir = mkdtempSync(join(import.meta.dir, "../../.local/kiro-meta-"));
  try {
    await applySchema(ch.client);
    const session = join(dir, "sessions/workspace/native");
    mkdirSync(session, { recursive: true });
    const meta = join(session, "session.json"), path = join(session, "messages.jsonl");
    writeFileSync(meta, JSON.stringify({ workspacePaths: ["/Users/test/Gits/tokenlayer"], modelId: "auto" }));
    writeFileSync(path, summary(0.125));
    const opts: ShipOptions = { machine: "fixture", roots: [{ kind: "kiro", dir: join(dir, "sessions") }],
      statePath: join(dir, "state.json"), clickhouse: ch.client, rateBytesPerSec: 0 };
    expect((await shipOnce(opts)).lines).toBe(1);
    if (mode === "torn") writeFileSync(meta, '{"modelId":');
    else unlinkSync(meta);
    appendFileSync(path, summary(0.25, "turn-2"));
    expect((await shipOnce(opts)).lines).toBe(1);
    expect(await ch.client.queryJSON("SELECT DISTINCT cwd, model FROM tokenlayer.session_events FINAL")).toEqual([{ cwd: "/Users/test/Gits/tokenlayer", model: "auto" }]);
    // Partial valid metadata updates only the field it supplies.
    writeFileSync(meta, JSON.stringify({ modelId: "updated-model" }));
    appendFileSync(path, summary(0.5, "turn-3"));
    expect((await shipOnce(opts)).lines).toBe(1);
    expect(await ch.client.queryJSON("SELECT cwd, model FROM tokenlayer.session_events FINAL ORDER BY byte_offset DESC LIMIT 1")).toEqual([{ cwd: "/Users/test/Gits/tokenlayer", model: "updated-model" }]);
  } finally { await ch.stop(); }
}, 40000);
