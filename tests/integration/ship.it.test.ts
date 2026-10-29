import { registerRewriteTests } from "../support/ship-rewrites";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "SELECT machine, harness, count() AS n, sum(output_tokens) AS output FROM tokenlayer.v_session_events_context GROUP BY machine, harness ORDER BY harness",
    );

  test("ships both harnesses; usage is credited once per message", async () => {
    const r = await shipOnce(opts);
    expect(r.lines).toBe(5);
    expect(Number((await ch.client.queryJSON<{ output: string }>("SELECT sum(output_tokens) AS output FROM tokenlayer.session_events FINAL"))[0].output)).toBe(40);
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
  test("raw readback is byte-identical and agent views omit payload columns", async () => {
    const line = ' { "type":"user", "message":{"content":"sk-ant-api03-SYNTHETIC01234567890123456789"} }\r\n';
    writeFileSync(join(dir, "claude", "exact.jsonl"), line);
    await shipOnce(opts);
    const [row] = await ch.client.queryJSON<{ raw: string }>("SELECT raw FROM tokenlayer.session_events FINAL WHERE endsWith(path, '/exact.jsonl')");
    expect(Buffer.from(row.raw)).toEqual(Buffer.from(line));
    const binary = Buffer.from([...Array.from({ length: 32 }, (_, i) => i).filter(i => i !== 10), 0x7f, 0xff, 0xfe, 34, 92, 10]);
    writeFileSync(join(dir, "claude", "binary.jsonl"), binary);
    await shipOnce(opts);
    const [stored] = await ch.client.queryJSON<{ bytes: string }>("SELECT hex(raw) AS bytes FROM tokenlayer.session_events FINAL WHERE endsWith(path, '/binary.jsonl')");
    expect(stored.bytes).toBe(binary.toString('hex').toUpperCase());
    for (const view of ['v_session_events_meta', 'v_requests']) {
      const cols = await ch.client.queryJSON<{ name: string }>(`DESCRIBE TABLE tokenlayer.${view}`);
      for (const payload of ['raw', 'fail_body', 'fail_code', 'user_agent', 'ratelimit']) expect(cols.map(c => c.name)).not.toContain(payload);
    }
  });

});

registerRewriteTests("normal");

describe.skipIf(!clickhouseBinary())("legacy schema migration", () => {
  test.each(["legacy", "generation"])("migrates %s key, preserves rows and is restartable", async (version) => {
    const ch = await startLocalClickHouse();
    try {
      await ch.client.exec("CREATE DATABASE tokenlayer");
      const old = version === "legacy"
        ? "CREATE TABLE tokenlayer.session_events (machine String, path String, byte_offset UInt64, ts DateTime64(3), raw String) ENGINE=ReplacingMergeTree ORDER BY (machine,path,byte_offset)"
        : readFileSync(join(import.meta.dir, "../../schema/004_session_events.sql"), "utf8")
          .replace(/^    content_hash.*\n/m, "").replace("ORDER BY (machine, path, generation, byte_offset, content_hash)", "ORDER BY (machine, path, generation, byte_offset)").replace(/;\s*$/, "");
      await ch.client.exec(old);
      await ch.client.exec("CREATE TABLE tokenlayer.session_events_legacy (raw String) ENGINE=MergeTree ORDER BY tuple()");
      await ch.client.exec("INSERT INTO tokenlayer.session_events (machine,path,byte_offset,ts,raw) VALUES ('test','synthetic',0,now(),'{}')");
      await expect(verifySessionSchema(ch.client)).rejects.toThrow("schema mismatch");
      await applySchema(ch.client);
      await verifySessionSchema(ch.client);
      const [{ sorting_key }] = await ch.client.queryJSON<{ sorting_key: string }>("SELECT sorting_key FROM system.tables WHERE database='tokenlayer' AND name='session_events'");
      expect(sorting_key).toBe("machine, path, generation, byte_offset, content_hash");
      expect((await ch.client.queryJSON("SELECT generation,message_id,raw FROM tokenlayer.session_events FINAL")))
        .toEqual([{ generation: version === "legacy" ? "legacy" : "", message_id: "", raw: "{}" }]);
      const [receipt] = await ch.client.queryJSON<{ content_hash: string }>("SELECT content_hash FROM tokenlayer.session_events FINAL");
      expect(receipt.content_hash).toMatch(/^legacy:[a-f0-9]{64}$/);
      expect(await ch.client.queryJSON("SELECT raw FROM tokenlayer.session_events_pre_content_hash")).toEqual([{ raw: "{}" }]);
      await applySchema(ch.client);
    } finally { await ch.stop(); }
  }, 40000);
});
