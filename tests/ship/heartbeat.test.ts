import { expect, test } from "bun:test";
import { StoreUnreachableError } from "../../src/lib/clickhouse";
import { errorClass, Heartbeat, HEARTBEAT_EVERY_MS, heartbeatRow } from "../../src/ship/heartbeat";

const NOW = Date.parse("2026-11-19T16:00:00Z");
const ok = { files: 2, lines: 40, bytes: 9000, durationMs: 120 };

/** A fake store that records every heartbeat insert, or refuses them while `down`. */
function store() {
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const s = {
    down: false,
    inserts,
    async insert(table: string, rows: readonly unknown[]) {
      if (s.down) throw new StoreUnreachableError("ENOTFOUND", "getaddrinfo ENOTFOUND hub.example", 1);
      inserts.push({ table, rows: rows as Record<string, unknown>[] });
    },
  };
  return s;
}

test("a pass row carries the machine, the counts and a fixed error class: never a path, a user name or a message", () => {
  const failed = new AggregateError([new Error("~/.claude/projects/private-repo/s.jsonl: EACCES")], "ship failed for some files");
  const row = heartbeatRow("m4", { ...ok, error: failed }, NOW);
  expect(row).toEqual({ machine: "m4", ts: "2026-11-19 16:00:00.000", result: "error", error_class: "file_errors", files: 2, lines: 40, bytes: 9000, duration_ms: 120 });
  expect(JSON.stringify(row)).not.toMatch(/claude|private-repo|EACCES/);
  expect(heartbeatRow("m1", ok, NOW)).toMatchObject({ result: "ok", error_class: "" });
});

test("error classes: the store was unreachable, some files failed, or something else", () => {
  expect(errorClass(undefined)).toBe("");
  expect(errorClass(new StoreUnreachableError("ENOTFOUND", "x", 4))).toBe("store_unreachable");
  // shipOnce wraps the per-file errors; an unreachable store stops the pass and keeps its class.
  const unreachable = Object.assign(new Error("getaddrinfo ENOTFOUND hub.example"), { name: "StoreUnreachableError" });
  expect(errorClass(new AggregateError([new Error("a"), unreachable], "ship failed for some files"))).toBe("store_unreachable");
  expect(errorClass(new AggregateError([new Error("a")], "ship failed for some files"))).toBe("file_errors");
  expect(errorClass(new Error("session_events schema drifted"))).toBe("other");
});

test("the first pass beats at once; later passes at most once a minute while nothing changes", async () => {
  const s = store();
  const hb = new Heartbeat(s, "m1");
  expect(await hb.beat(ok, NOW)).toBe(true);
  expect(await hb.beat(ok, NOW + 10_000)).toBe(false);
  expect(await hb.beat(ok, NOW + HEARTBEAT_EVERY_MS - 1)).toBe(false);
  expect(await hb.beat(ok, NOW + HEARTBEAT_EVERY_MS)).toBe(true);
  expect(s.inserts.map((i) => i.table)).toEqual(["ship_heartbeat", "ship_heartbeat"]);
  expect(s.inserts.map((i) => i.rows.length)).toEqual([1, 1]);
});

test("a pass whose result changes beats at once, inside the minute", async () => {
  const s = store();
  const hb = new Heartbeat(s, "m1");
  await hb.beat(ok, NOW);
  expect(await hb.beat({ ...ok, error: new AggregateError([new Error("x")]) }, NOW + 10_000)).toBe(true);
  expect(await hb.beat(ok, NOW + 20_000)).toBe(true);
  expect(s.inserts.map((i) => i.rows[0]!.error_class)).toEqual(["", "file_errors", ""]);
});

test("a heartbeat that cannot be written never throws and is retried on the next pass", async () => {
  const s = store();
  const logs: string[] = [];
  const hb = new Heartbeat(s, "m4", HEARTBEAT_EVERY_MS, (m) => logs.push(m));
  s.down = true;
  expect(await hb.beat(ok, NOW)).toBe(false);
  expect(await hb.beat(ok, NOW + 10_000)).toBe(false);
  s.down = false;
  expect(await hb.beat(ok, NOW + 20_000)).toBe(true);
  expect(s.inserts).toHaveLength(1);
  // Logged once per outage, by class only.
  expect(logs).toEqual(["heartbeat not written: store_unreachable"]);
});
