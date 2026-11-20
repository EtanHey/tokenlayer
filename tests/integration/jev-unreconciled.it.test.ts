import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { drainOnce } from "../../src/jev/drain";
// @ts-expect-error untyped ratchet judge
import { evaluate } from "../../ratchet/table.mjs";

const ROW_ID = "jev_unreconciled_24h";
const row = (JSON.parse(readFileSync(join(import.meta.dir, "../../ratchet/rows.json"), "utf8")).rows as { id: string; command: string }[]).find((r) => r.id === ROW_ID);
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace("Z", "123Z");
const id = (n: number) => n.toString(16).padStart(32, "0");
const line = (kind: "reservation" | "reconciliation", n: number, minutesAgo: number) => JSON.stringify(kind === "reservation"
  ? { ts: iso(minutesAgo), site: "fixture", model: "jev-latest", kind, reservation_id: id(n), reserved_input_tokens: 64000, cost_usd: 0.002688 }
  : { ts: iso(minutesAgo), site: "fixture", model: "jev-1.14.0", kind, reservation_id: id(n), input_tokens: 300, cost_usd: -0.0026754 });

describe.skipIf(!clickhouseBinary())("ratchet row jev_unreconciled_24h → real local ClickHouse", () => {
  let ch: LocalClickHouse;
  let dir: string;
  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    dir = mkdtempSync(join(tmpdir(), "jev-ratchet-"));
    mkdirSync(join(dir, "home"));
    mkdirSync(join(dir, "roots/state"), { recursive: true });
  }, 40000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const ledger = (lines: string[]) => writeFileSync(join(dir, "roots/state/usage.jsonl"), lines.join("\n") + "\n");
  const drain = () => drainOnce({ machine: "fixture", roots: [join(dir, "roots")], maxDepth: 2, statePath: join(dir, "state.json"), clickhouse: ch.client });
  /** The row's own command against the local server; HOME is empty so no real credentials are read. */
  const measure = () => {
    const run = Bun.spawnSync(["bash", "-c", row!.command], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, HOME: join(dir, "home"), CLICKHOUSE_URL: ch.client.config.url, CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "", CLICKHOUSE_DB: "tokenlayer" },
    });
    expect({ exit: run.exitCode, stderr: run.stderr.toString().slice(-500) }).toEqual({ exit: 0, stderr: "" });
    return Number(run.stdout.toString().trim().split("\n").pop());
  };

  test("the row exists, runs on the M1 and allows no unreconciled call", () => {
    expect(row).toMatchObject({ runner: "m1", direction: "max", ceiling: 0, kind: "unit" });
  });

  test("a reservation with no reconciliation after the grace period trips the row", async () => {
    ledger([
      line("reservation", 1, 30), // crashed call: no reconciliation after 30 min
      line("reservation", 2, 40), line("reconciliation", 2, 39), // healthy call
      line("reservation", 3, 5), // still within the 15 min grace period
      line("reservation", 4, 3 * 24 * 60), // older than the 24 h window
    ]);
    await drain();
    const value = measure();
    expect(value).toBe(1);
    expect(evaluate(row, value)).toBe(false);
  });

  test("its late reconciliation clears the row", async () => {
    ledger([
      line("reservation", 1, 30), line("reconciliation", 1, 1),
      line("reservation", 2, 40), line("reconciliation", 2, 39),
      line("reservation", 3, 5),
      line("reservation", 4, 3 * 24 * 60),
    ]);
    await drain();
    const value = measure();
    expect(value).toBe(0);
    expect(evaluate(row, value)).toBe(true);
  });
});
