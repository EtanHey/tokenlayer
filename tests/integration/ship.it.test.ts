import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
