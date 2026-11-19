import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
// @ts-expect-error untyped ratchet judge
import { evaluate } from "../../ratchet/table.mjs";

const repo = join(import.meta.dir, "../..");
const rows = JSON.parse(readFileSync(join(repo, "ratchet/rows.json"), "utf8")).rows as { id: string; command: string }[];
const row = (id: string) => rows.find((r) => r.id === id)!;

describe.skipIf(!clickhouseBinary())("ship heartbeat → real local ClickHouse → the live heartbeat rows", () => {
  let ch: LocalClickHouse;
  let dir: string;
  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    mkdirSync(join(repo, ".local"), { recursive: true });
    dir = mkdtempSync(join(repo, ".local/ship-heartbeat-it-"));
  }, 40000);
  afterAll(async () => {
    await ch?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const chEnv = () => ({ CLICKHOUSE_URL: ch.client.config.url, CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "", CLICKHOUSE_DB: "tokenlayer" });
  const beats = async () => (await ch.client.queryJSON<{ machine: string; result: string; error_class: string; age: number }>(
    "SELECT machine, result, error_class, dateDiff('millisecond', ingested_at, now64(3)) / 1000 AS age FROM tokenlayer.ship_heartbeat ORDER BY ingested_at"));
  /** The live row's own command, as the M1's 15-minute job runs it; HOME is empty so no real credentials are read. */
  const measure = (id: string, extra: Record<string, string> = {}) => {
    const run = Bun.spawnSync(["bash", "-c", row(id).command], {
      cwd: repo, env: { ...process.env, HOME: dir, ...chEnv(), ...extra }, timeout: 25_000,
    });
    return { exit: run.exitCode, out: run.stdout.toString().trim().split("\n").pop() ?? "" };
  };
  /** The real ship daemon on empty session roots, stopped with SIGTERM once its first heartbeat landed. */
  const runDaemon = async (machine: string) => {
    const before = (await beats()).length;
    const proc = Bun.spawn([process.execPath, join(repo, "src/ship/main.ts")], {
      env: {
        PATH: process.env.PATH, HOME: dir, TOKENLAYER_ENV_FILES: join(dir, "missing.env"), TOKENLAYER_MACHINE: machine,
        TOKENLAYER_SHIP_INTERVAL_MS: "200", TOKENLAYER_SHIP_STATE: join(dir, `${machine}.state`),
        TOKENLAYER_CLAUDE_DIR: join(dir, "empty"), TOKENLAYER_CODEX_DIR: join(dir, "empty"), TOKENLAYER_KIRO_DIR: join(dir, "empty"),
        TOKENLAYER_ANTIGRAVITY_CLI_DIR: join(dir, "empty"), TOKENLAYER_T3_ANTIGRAVITY_DIR: join(dir, "empty"), TOKENLAYER_KIRO_T3_STATE: join(dir, "none.sqlite"),
        ...chEnv(),
      }, stdout: "pipe", stderr: "pipe",
    });
    for (let i = 0; i < 100 && (await beats()).length === before; i++) await Bun.sleep(100);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    // 200 ms passes for a few seconds still write one row: the next is due a minute later.
    return (await beats()).length - before;
  };

  test("the schema path creates the heartbeat table empty, with no session content columns", async () => {
    const columns = (await ch.client.queryJSON<{ name: string }>("SELECT name FROM system.columns WHERE database = 'tokenlayer' AND table = 'ship_heartbeat' ORDER BY position")).map((c) => c.name);
    expect(columns).toEqual(["machine", "ts", "result", "error_class", "files", "lines", "bytes", "duration_ms", "ingested_at"]);
    expect(await beats()).toEqual([]);
  });

  test("no heartbeat yet on the M1: MISSING (the row's command fails), not a pass", () => {
    expect(measure("ship_heartbeat_age_s_m1").exit).not.toBe(0);
  });

  test("the real daemon beats once per minute per Mac; the M1 row reads it fresh and passes", async () => {
    expect(await runDaemon("m1")).toBe(1);
    const [beat] = await beats();
    expect(beat).toMatchObject({ machine: "m1", result: "ok", error_class: "" });
    const { exit, out } = measure("ship_heartbeat_age_s_m1");
    expect(exit).toBe(0);
    expect(Number(out)).toBeLessThan(30);
    expect(evaluate(row("ship_heartbeat_age_s_m1"), Number(out))).toBe(true);
  }, 30000);

  test("dead shipper: a last heartbeat 20 min old trips the M1 row; a restart clears it", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.ship_heartbeat");
    await ch.client.exec("INSERT INTO tokenlayer.ship_heartbeat (machine, ts, result, error_class, files, lines, bytes, duration_ms, ingested_at) VALUES ('m1', now64(3) - INTERVAL 20 MINUTE, 'ok', '', 0, 0, 0, 5, now64(3) - INTERVAL 20 MINUTE), ('m4', now64(3), 'ok', '', 0, 0, 0, 5, now64(3))");
    const dead = measure("ship_heartbeat_age_s_m1");
    expect(dead.exit).toBe(0);
    expect(Number(dead.out)).toBeGreaterThan(1199);
    expect(evaluate(row("ship_heartbeat_age_s_m1"), Number(dead.out))).toBe(false);
    // The other Mac's fresh beat never hides this one's silence.
    expect(await runDaemon("m1")).toBe(1);
    const recovered = Number(measure("ship_heartbeat_age_s_m1").out);
    expect(recovered).toBeLessThan(30);
    expect(evaluate(row("ship_heartbeat_age_s_m1"), recovered)).toBe(true);
  }, 30000);

  test("asleep: the M4 row skips (state held) when ssh cannot reach the M4, however old its heartbeat", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.ship_heartbeat");
    await ch.client.exec("INSERT INTO tokenlayer.ship_heartbeat (machine, ts, result, error_class, files, lines, bytes, duration_ms, ingested_at) VALUES ('m4', now64(3) - INTERVAL 6 HOUR, 'ok', '', 0, 0, 0, 5, now64(3) - INTERVAL 6 HOUR)");
    expect(measure("ship_heartbeat_age_s_m4", { TOKENLAYER_M4_HOST: "h1-unreachable.invalid" })).toEqual({ exit: 0, out: "skip" });
  });

  /** n beats for a Mac, one a minute back from now, each 'ok' or an error class. */
  const insertBeats = (machine: string, classes: string[]) => ch.client.exec(
    `INSERT INTO tokenlayer.ship_heartbeat (machine, ts, result, error_class, files, lines, bytes, duration_ms, ingested_at) VALUES ${classes.map((c, i) =>
      `('${machine}', now64(3) - INTERVAL ${i} MINUTE, '${c === "ok" ? "ok" : "error"}', '${c === "ok" ? "" : c}', 0, 0, 0, 5, now64(3) - INTERVAL ${i} MINUTE)`).join(", ")}`);
  const failing = (machine: string, extra: Record<string, string> = {}) => {
    const { exit, out } = measure(`ship_heartbeat_failing_${machine}`, extra);
    expect(exit).toBe(0);
    return out === "skip" ? "skip" : JSON.parse(out) as { value: number; threshold: number; say: string };
  };

  test("failing shipper: every M1 beat in the last 15 min is an error → the failing row trips; an older ok beat doesn't save it", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.ship_heartbeat");
    // 14 failing beats in the window, the last ok pass 20 min ago, and a healthy M4 that must not hide the M1.
    await insertBeats("m1", [...Array(14).fill("file_errors"), "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    await insertBeats("m4", Array(15).fill("ok"));
    const m = failing("m1");
    expect(m).toEqual({ value: 14, threshold: 0, say: "all 14 heartbeats in the last 15 min failed (file_errors): the shipper runs, but no pass succeeds" });
    expect(evaluate(row("ship_heartbeat_failing_m1"), (m as { value: number }).value)).toBe(false);
    // The age row stays green: the shipper is alive, which is why this row exists.
    expect(evaluate(row("ship_heartbeat_age_s_m1"), Number(measure("ship_heartbeat_age_s_m1").out))).toBe(true);
  });

  test("mixed: one ok beat among the failures in the window passes", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.ship_heartbeat");
    await insertBeats("m1", ["file_errors", "other", "ok", "file_errors", "store_unreachable"]);
    expect(failing("m1")).toEqual({ value: 0, threshold: 0, say: "1 of 5 heartbeats in the last 15 min ok" });
  });

  test("recovery: the real daemon's next ok pass clears the failing row", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.ship_heartbeat");
    await insertBeats("m1", Array(10).fill("other"));
    expect(failing("m1")).toMatchObject({ value: 10 });
    expect(await runDaemon("m1")).toBe(1);
    const m = failing("m1");
    expect(m).toEqual({ value: 0, threshold: 0, say: "1 of 11 heartbeats in the last 15 min ok" });
    expect(evaluate(row("ship_heartbeat_failing_m1"), (m as { value: number }).value)).toBe(true);
  }, 30000);

  test("no beat in the window holds the state (the age row's job); an unreachable M4 skips however it fails", async () => {
    await ch.client.exec("TRUNCATE TABLE tokenlayer.ship_heartbeat");
    expect(failing("m1")).toBe("skip");
    await insertBeats("m4", Array(15).fill("file_errors"));
    expect(failing("m4", { TOKENLAYER_M4_HOST: "h2-unreachable.invalid" })).toBe("skip");
  });
});
