import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySessionSchema } from "../../src/lib/session-schema";
import { applySchema } from "../../src/lib/schema";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../support/local-clickhouse";

describe.skipIf(!clickhouseBinary())("ship → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  let dir: string;
  let opts: ShipOptions;

  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    dir = mkdtempSync(join(tmpdir(), "tokenlayer-ship-it-"));
    mkdirSync(join(dir, "claude", "p"), { recursive: true });
    mkdirSync(join(dir, "codex"), { recursive: true });
    const assistant = (i: number) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "s-1",
        cwd: "/Users/u/Gits/golems",
        entrypoint: "sdk-ts",
        timestamp: `2026-10-28T08:00:0${i}Z`,
        message: { id: `msg_${i >> 1}`, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 10 } },
      });
    writeFileSync(join(dir, "claude", "p", "s-1.jsonl"), [0, 1, 2, 3].map(assistant).join("\n") + "\n");
    writeFileSync(
      join(dir, "codex", "r.jsonl"),
      JSON.stringify({ timestamp: "2026-09-30T23:59:59Z", type: "session_meta", payload: { id: "c-1", cwd: "/x/brainlayer", originator: "codex_exec" } }) + "\n",
    );
    opts = {
      machine: "m4",
      roots: [
        { kind: "claude", dir: join(dir, "claude") },
        { kind: "codex", dir: join(dir, "codex") },
      ],
      clickhouse: ch.client,
      statePath: join(dir, "state.json"),
      rateBytesPerSec: 0,
    };
  }, 40_000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const counts = async () =>
    ch.client.queryJSON<{ machine: string; harness: string; n: string; output: string }>(
      "SELECT machine, harness, count() AS n, sum(output_tokens) AS output FROM tokenlayer.session_events FINAL GROUP BY machine, harness ORDER BY harness",
    );

  test("ships both harnesses; usage is credited once per message", async () => {
    const r = await shipOnce(opts);
    expect(r.lines).toBe(5);
    expect((await counts()).map((c) => [c.machine, c.harness, Number(c.n), Number(c.output)])).toEqual([
      ["m4", "codex", 1, 0],
      ["m4", "t3", 4, 20],
    ]);
  });

  test("re-running with the checkpoint adds 0 rows; re-running without it adds 0 rows after FINAL", async () => {
    const again = await shipOnce(opts);
    expect(again.lines).toBe(0);
    rmSync(opts.statePath);
    const fromScratch = await shipOnce(opts);
    expect(fromScratch.lines).toBe(5);
    await ch.client.exec("OPTIMIZE TABLE tokenlayer.session_events FINAL");
    const [{ n }] = await ch.client.queryJSON<{ n: string }>("SELECT count() AS n FROM tokenlayer.session_events");
    expect(Number(n)).toBe(5);
  });

  test("appended lines land in order; rows span monthly partitions", async () => {
    appendFileSync(join(dir, "codex", "r.jsonl"), JSON.stringify({ timestamp: "2026-10-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.5" } }) + "\n");
    await shipOnce(opts);
    const parts = await ch.client.queryJSON<{ partition: string }>(
      "SELECT DISTINCT partition FROM system.parts WHERE database = 'tokenlayer' AND table = 'session_events' AND active ORDER BY partition",
    );
    expect(parts.map((p) => p.partition)).toEqual(["202609", "202610"]);
  });
});

describe.skipIf(!clickhouseBinary())("ship → real local ClickHouse: rewrites, rotation, replays", () => {
  let ch: LocalClickHouse;
  let dir: string;

  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    dir = mkdtempSync(join(tmpdir(), "tokenlayer-ship-it2-"));
  }, 40_000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Each test gets its own machine name and root, so assertions never see another test's rows. */
  const setup = (machine: string, batchBytes?: number) => {
    const root = join(dir, machine);
    mkdirSync(join(root, "p"), { recursive: true });
    const o: ShipOptions = {
      machine,
      roots: [{ kind: "claude", dir: root }],
      clickhouse: ch.client,
      statePath: join(dir, `${machine}.state.json`),
      rateBytesPerSec: 0,
      batchBytes,
    };
    return { file: join(root, "p", "s.jsonl"), o };
  };
  const line = (text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "user", sessionId: "s", timestamp: new Date().toISOString(), message: { role: "user", content: text }, ...extra });
  const finalRows = (machine: string) =>
    ch.client.queryJSON<{ generation: string; byte_offset: string; harness: string; content: string }>(
      `SELECT generation, byte_offset, harness, JSONExtractString(raw, 'message', 'content') AS content
       FROM tokenlayer.session_events FINAL WHERE machine = '${machine}' ORDER BY ingested_at, byte_offset`,
    );

  test("a late harness decision replaces the first chunk even when its byte range is unchanged", async () => {
    const { file, o } = setup("it-late", 1);
    writeFileSync(file, `${JSON.stringify({ type: "queue-operation", sessionId: "s", timestamp: new Date().toISOString() })}\n`);
    await shipOnce(o);
    appendFileSync(file, `${line("two", { entrypoint: "sdk-ts" })}\n`);
    await shipOnce(o);
    expect((await finalRows("it-late")).map((r) => [Number(r.byte_offset), r.harness])).toEqual([
      [0, "t3"],
      [expect.any(Number), "t3"],
    ]);
  });

  test("a same-inode equal-size rewrite is shipped, and the earlier generation is kept", async () => {
    const { file, o } = setup("it-rewrite", 1);
    writeFileSync(file, `${line("old")}\n${line("two")}\n`);
    await shipOnce(o);
    writeFileSync(file, `${line("new")}\n${line("two")}\n`);
    const r = await shipOnce(o);
    expect(r.resets).toBe(1);
    const rows = await finalRows("it-rewrite");
    expect(rows.map((x) => x.content).sort()).toEqual(["new", "old", "two", "two"]);
    expect(new Set(rows.map((x) => x.generation)).size).toBe(2);
  });

  test("rotation to a backup name keeps the archived history of the old file", async () => {
    const { file, o } = setup("it-rotate");
    writeFileSync(file, `${line("old")}\n`);
    await shipOnce(o);
    renameSync(file, `${file}.bak`);
    writeFileSync(file, `${line("new")}\n`);
    await shipOnce(o);
    expect((await finalRows("it-rotate")).map((x) => x.content).sort()).toEqual(["new", "old"]);
  });

  test("the documented activity query counts a replay with shifted chunk boundaries once", async () => {
    const { file, o } = setup("it-activity");
    const assistant = (i: number) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "s",
        cwd: "/Users/u/Gits/golems",
        timestamp: new Date().toISOString(),
        message: { id: `msg_${i}`, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 10 } },
      });
    await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events");
    try {
      writeFileSync(file, `${assistant(1)}\n`);
      await shipOnce(o);
      rmSync(o.statePath);
      appendFileSync(file, `${assistant(2)}\n`);
      await shipOnce(o);
      const [{ physical }] = await ch.client.queryJSON<{ physical: string }>(
        "SELECT count() AS physical FROM tokenlayer.session_events WHERE machine = 'it-activity'",
      );
      expect(Number(physical)).toBe(3);

      const doc = await Bun.file(join(import.meta.dir, "..", "..", "docs", "telemetry.md")).text();
      const activity = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).find((q) => q.includes("tokenlayer.session_events"));
      expect(activity).toBeDefined();
      const [agg] = await ch.client.queryJSON<{ events: string; output: string }>(
        `SELECT sum(events) AS events, sum(output_tokens) AS output FROM (${activity}) WHERE machine = 'it-activity'`,
      );
      expect([Number(agg.events), Number(agg.output)]).toEqual([2, 20]);
    } finally {
      await ch.client.exec("SYSTEM START MERGES tokenlayer.session_events");
    }
  });
});

describe.skipIf(!clickhouseBinary())("legacy schema migration", () => {
  test("changes the replacement key, preserves rows, and is restartable", async () => {
    const ch = await startLocalClickHouse();
    try {
      await ch.client.exec("CREATE DATABASE tokenlayer");
      await ch.client.exec("CREATE TABLE tokenlayer.session_events (machine String, path String, byte_offset UInt64, ts DateTime64(3), raw String) ENGINE=ReplacingMergeTree ORDER BY (machine,path,byte_offset)");
      await ch.client.exec("INSERT INTO tokenlayer.session_events VALUES ('test','synthetic',0,now(),'{}')");
      await expect(verifySessionSchema(ch.client)).rejects.toThrow("schema mismatch");
      await applySchema(ch.client);
      await verifySessionSchema(ch.client);
      const [{ sorting_key }] = await ch.client.queryJSON<{ sorting_key: string }>("SELECT sorting_key FROM system.tables WHERE database='tokenlayer' AND name='session_events'");
      expect(sorting_key).toBe("machine, path, generation, byte_offset");
      expect((await ch.client.queryJSON("SELECT generation,message_id FROM tokenlayer.session_events FINAL"))).toEqual([{ generation: "legacy", message_id: "" }]);
      await applySchema(ch.client);
    } finally { await ch.stop(); }
  }, 40000);
});
