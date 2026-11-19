import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainOnce, findLedgers } from "../../src/jev/drain";

const fixtures = join(import.meta.dir, "../fixtures/jev");
type Insert = { table: string; rows: Record<string, unknown>[]; token?: string };

let dir: string;
let inserts: Insert[];
let failNext: boolean;
const clickhouse = {
  async insert(table: string, rows: readonly unknown[], token?: string) {
    if (failNext) { failNext = false; throw new Error("clickhouse insert failed: HTTP 503"); }
    inserts.push({ table, rows: rows as Record<string, unknown>[], token });
  },
};
const opts = () => ({ machine: "m4", roots: [join(dir, "roots")], maxDepth: 4, statePath: join(dir, "state.json"), clickhouse });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-drain-"));
  inserts = [];
  failNext = false;
  mkdirSync(join(dir, "roots/research/E8-state-live"), { recursive: true });
  mkdirSync(join(dir, "roots/research/E8-state"), { recursive: true });
  copyFileSync(join(fixtures, "e8-state-live.usage.jsonl"), join(dir, "roots/research/E8-state-live/usage.jsonl"));
  copyFileSync(join(fixtures, "e8-state-preflight.usage.jsonl"), join(dir, "roots/research/E8-state/usage.jsonl"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Jev ledger drain", () => {
  test("finds usage.jsonl ledgers within the depth limit, skipping node_modules, .git and deeper files", () => {
    for (const p of ["a/b/c/d/e/usage.jsonl", "x/node_modules/usage.jsonl", "x/.git/usage.jsonl", "x/other.jsonl"]) {
      mkdirSync(join(dir, "roots", p, ".."), { recursive: true });
      writeFileSync(join(dir, "roots", p), "");
    }
    expect(findLedgers([join(dir, "roots"), join(dir, "missing")], 4).map((p) => p.slice(dir.length))).toEqual([
      "/roots/research/E8-state-live/usage.jsonl",
      "/roots/research/E8-state/usage.jsonl",
    ]);
  });

  test("ingests one row per call into systemone_calls and counts every ledger line", async () => {
    const r = await drainOnce(opts());
    expect(r).toEqual({ ledgers: 2, lines: 325, reservations: 163, reconciliations: 162, invalid: 0, duplicates: 0, calls: 163, inserted: 163, unreconciled: 1 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("systemone_calls");
    expect(inserts[0].token).toMatch(/^jev:[0-9a-f]{64}$/);
    expect(new Set(inserts[0].rows.map((row) => row.reservation_id)).size).toBe(163);
  });

  test("a re-read inserts nothing; an orphan reconciliation adds only its own row", async () => {
    await drainOnce(opts());
    expect((await drainOnce(opts())).inserted).toBe(0);
    expect(inserts).toHaveLength(1);
    const ledger = join(dir, "roots/research/E8-state/usage.jsonl");
    appendFileSync(ledger, JSON.stringify({ ts: "2026-11-18T00:31:31.000000Z", site: "jev_e8_wake_gate", model: "jev-1.13.0", kind: "reconciliation", reservation_id: "a2c4e0f62a5b4f53a1f1ca0b8d0c2a11", input_tokens: 10, cost_usd: -0.0026876 }) + "\n");
    expect(await drainOnce(opts())).toMatchObject({ inserted: 1, calls: 164 });
    expect(inserts[1].rows).toEqual([expect.objectContaining({ reservation_id: "a2c4e0f62a5b4f53a1f1ca0b8d0c2a11", accounting_quality: "orphan_reconciliation", reserved_at: null, ts: "2026-11-18 00:31:31.000" })]);
  });

  test("reconciling the unreconciled preflight replaces its row", async () => {
    await drainOnce(opts());
    const [held] = inserts[0].rows.filter((row) => row.accounting_quality === "unreconciled");
    appendFileSync(join(dir, "roots/research/E8-state/usage.jsonl"), JSON.stringify({ ts: "2026-11-18T00:31:31.000000Z", site: "jev_e8_wake_gate", model: "jev-1.13.0", kind: "reconciliation", reservation_id: held.reservation_id, input_tokens: 10, cost_usd: -0.0026876 }) + "\n");
    const r = await drainOnce(opts());
    expect(r).toMatchObject({ inserted: 1, unreconciled: 0 });
    expect(inserts[1].rows).toEqual([expect.objectContaining({ reservation_id: held.reservation_id, accounting_quality: "measured", input_tokens: 10 })]);
  });

  test("a failed insert saves no state, so the next run retries the same batch", async () => {
    failNext = true;
    await expect(drainOnce(opts())).rejects.toThrow("HTTP 503");
    const r = await drainOnce(opts());
    expect(r.inserted).toBe(163);
  });

  test("files named usage.jsonl that are not Jev ledgers are not counted", async () => {
    mkdirSync(join(dir, "roots/other"), { recursive: true });
    writeFileSync(join(dir, "roots/other/usage.jsonl"), '{"tokens":1}\n{"tokens":2}\n');
    expect(await drainOnce(opts())).toMatchObject({ ledgers: 2, lines: 325, invalid: 0 });
  });

  test("dry run reports the same counts without inserting or saving state", async () => {
    const r = await drainOnce({ ...opts(), dryRun: true });
    expect(r).toMatchObject({ calls: 163, inserted: 0 });
    expect(inserts).toHaveLength(0);
    expect((await drainOnce(opts())).inserted).toBe(163);
  });
});
