import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { drainOnce } from "../../src/jev/drain";
import { parseLedgerText } from "../../src/jev/ledger";
import { readFileSync } from "node:fs";

const fixtures = join(import.meta.dir, "../fixtures/jev");

describe.skipIf(!clickhouseBinary())("Jev ledgers → real local ClickHouse systemone_calls", () => {
  let ch: LocalClickHouse;
  let dir: string;
  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    dir = mkdtempSync(join(tmpdir(), "jev-it-"));
    for (const [name, sub] of [["e8-state-live", "E8-state-live"], ["e8-state-preflight", "E8-state"]]) {
      mkdirSync(join(dir, "roots", sub), { recursive: true });
      copyFileSync(join(fixtures, `${name}.usage.jsonl`), join(dir, "roots", sub, "usage.jsonl"));
    }
  }, 40000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const opts = (state = "state.json") => ({ machine: "fixture", roots: [join(dir, "roots")], maxDepth: 3, statePath: join(dir, state), clickhouse: ch.client });
  const scalar = async (sql: string) => Number((await ch.client.exec(sql)).trim());

  test("one row per call, every ledger line accounted for, and a lost state re-read adds no rows", async () => {
    const first = await drainOnce(opts());
    expect(first).toMatchObject({ lines: 325, reservations: 163, reconciliations: 162, calls: 163, inserted: 163, unreconciled: 1 });
    expect(await scalar("SELECT count() FROM tokenlayer.systemone_calls FINAL")).toBe(163);
    expect(await scalar("SELECT countIf(isNotNull(reserved_at)) + countIf(isNotNull(reconciled_at)) FROM tokenlayer.systemone_calls FINAL")).toBe(325);
    // A fresh state file re-sends the identical batch; its deduplication token makes the insert a no-op.
    expect((await drainOnce(opts("lost-state.json"))).inserted).toBe(163);
    expect(await scalar("SELECT count() FROM tokenlayer.systemone_calls")).toBe(163);
  });

  test("ledger net cost and tokens survive the round trip; typesafe appears in the provider comparison", async () => {
    const lines = ["e8-state-live", "e8-state-preflight"].flatMap((n) => parseLedgerText(readFileSync(join(fixtures, `${n}.usage.jsonl`), "utf8")).lines);
    const cost = lines.reduce((s, l) => s + l.cost_usd, 0);
    const tokens = lines.reduce((s, l) => s + (l.input_tokens ?? 0), 0);
    expect(await scalar("SELECT sum(cost_usd) FROM tokenlayer.systemone_calls FINAL")).toBeCloseTo(cost, 12);
    const rows = await ch.client.queryJSON<{ tokens: number; cost_usd: number }>("SELECT sum(tokens) AS tokens, sum(cost_usd) AS cost_usd FROM tokenlayer.v_provider_usage_compare WHERE provider = 'typesafe'");
    expect(rows[0].tokens).toBe(tokens);
    expect(rows[0].cost_usd).toBeCloseTo(cost, 12);
    expect(await scalar("SELECT countIf(isNotNull(cost_usd)) FROM tokenlayer.v_provider_usage_compare WHERE provider != 'typesafe'")).toBe(0);
  });

  test("a late reconciliation replaces the unreconciled row", async () => {
    const id = (await ch.client.queryJSON<{ reservation_id: string }>("SELECT reservation_id FROM tokenlayer.systemone_calls FINAL WHERE accounting_quality = 'unreconciled'"))[0].reservation_id;
    appendFileSync(join(dir, "roots/E8-state/usage.jsonl"), JSON.stringify({ ts: "2026-09-22T18:31:13.000000Z", site: "jev_e8_wake_gate", model: "jev-1.13.0", kind: "reconciliation", reservation_id: id, input_tokens: 10, cost_usd: -0.0026876 }) + "\n");
    expect((await drainOnce(opts())).inserted).toBe(1);
    expect(await ch.client.queryJSON(`SELECT accounting_quality, input_tokens FROM tokenlayer.systemone_calls FINAL WHERE reservation_id = '${id}'`)).toEqual([{ accounting_quality: "measured", input_tokens: 10 }]);
    expect(await scalar("SELECT count() FROM tokenlayer.systemone_calls FINAL")).toBe(163);
  });
});
