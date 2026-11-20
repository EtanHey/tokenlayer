import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { burnSQL, burnRise, burnVerdict, DEFAULT_RESERVE_PCT, readReserve, type Point, type Reserve } from "../../ratchet/burn";
import { liveRows, plan } from "../../ratchet/live-schedule";

const rows = JSON.parse(readFileSync("ratchet/rows.json", "utf8")).rows;
const row = liveRows(rows).find((r) => r.id === "claude_burn_2h")!;
const PREFIX = "### tokenlayer-ratchet → @tokenlayer-lead @orc — ";
const NOW = Date.parse("2026-11-19T12:00:00Z") / 1000; // Thu 14:00 IST
const START = NOW - 7200;
const RESET = NOW + 37 * 3600; // Sat 03:00 IST: 45% left − 8% reserve over 37 h = 1%/h
const reserve: Reserve = { pct: 8, from: "file" };
const base = (u: number, account = "a", reset = RESET): Point => ({ account, base: 1, bucket: 0, u, reset, at: START - 600 });
const at = (min: number, u: number, account = "a", reset = RESET): Point => ({ account, base: 0, bucket: START + min * 60, u, reset, at: START + min * 60 + 30 });
/** One reading per 15-minute bucket across the window, rising `perHour` points an hour to 0.55 at the end. */
const usage = (perHour: number) => [base(0.55 - perHour / 50), ...Array.from({ length: 8 }, (_, i) => at(i * 15, Math.round((0.55 - perHour / 100 * (7 - i) / 4) * 1e4) / 1e4))];
const judge = (v: ReturnType<typeof burnVerdict>, previous = {}) => plan([{ row, ...v }], previous, new Date(NOW * 1000));
const TAIL = "against a 1%/h target (alarm under 0.5%/h for 2 h or over 2%/h for 1 h); target = (45% of the week left − 8% reserve) / 37 h until the reset Sat 03:00 IST";

test("under-run: flat usage for 2 h fails, and the line says rate, target, reserve, % left and the reset in IST", () => {
  const v = burnVerdict(usage(0), reserve, NOW);
  expect(v).toEqual({ value: 0, threshold: 0.5, fail: true, say: `under half the target: Claude ran 0%/h for the last 2 h and 0%/h for the last hour ${TAIL}` });
  const { lines, state } = judge(v);
  expect(state.claude_burn_2h).toBe("fail");
  expect(lines).toEqual([`${PREFIX}2026-11-19T12:00:00Z FAIL claude_burn_2h: ${v.say}`]);
});

test("on target: 1%/h clears the row with one cleared line", () => {
  const v = burnVerdict(usage(1), reserve, NOW);
  expect(v).toMatchObject({ value: 1, threshold: 0.5, fail: false });
  const { lines, state } = judge(v, { claude_burn_2h: "fail" });
  expect(state.claude_burn_2h).toBe("pass");
  expect(lines).toEqual([`${PREFIX}2026-11-19T12:00:00Z cleared claude_burn_2h: Claude ran 1%/h for the last 2 h and 1%/h for the last hour ${TAIL}`]);
});

test("over-run: more than twice the target in the last hour fails, even when the 2 h average looks fine", () => {
  // Quiet first hour, then 0.48 → 0.55 in the last hour: 3.5%/h over 2 h, 7%/h over 1 h, against 1%/h.
  const v = burnVerdict([base(0.48), at(15, 0.48), at(45, 0.48), at(75, 0.51), at(105, 0.55)], reserve, NOW);
  expect(v).toMatchObject({ value: 3.5, fail: true });
  expect(v.say).toBe(`over twice the target: Claude ran 3.5%/h for the last 2 h and 7%/h for the last hour ${TAIL}`);
  expect(judge(v).state.claude_burn_2h).toBe("fail");
  // Exactly twice the target in the last hour is still fine; the 2 h rate alone never trips the over-run side.
  expect(burnVerdict([base(0.53), at(65, 0.53), at(105, 0.55)], reserve, NOW).fail).toBe(false);
});

test("the under-run edge: exactly half the target passes, just under it fails", () => {
  expect(burnVerdict([base(0.54), at(105, 0.55)], reserve, NOW)).toMatchObject({ value: 0.5, fail: false });
  expect(burnVerdict([base(0.541), at(105, 0.55)], reserve, NOW)).toMatchObject({ value: 0.45, fail: true });
});

test("no data: no weekly reading in 8 days cannot give a target, and fails rather than pass silently", () => {
  const v = burnVerdict([], reserve, NOW);
  expect(v).toEqual({ value: 0, threshold: null, fail: true, say: "no Claude weekly reading in 8 days, so no target: Claude ran 0%/h for the last 2 h; 8% reserve" });
  expect(judge(v).state.claude_burn_2h).toBe("fail");
});

test("a passed reset starts a new window: 100% of the new week is left until the next weekly reset", () => {
  const old = NOW - 3600; // the in-use account's week reset at Thu 13:00 IST, no reading since
  const v = burnVerdict([base(0.97, "a", old)], reserve, NOW);
  // (100 − 8) / 167 h = 0.55%/h; 0%/h is under half of it.
  expect(v).toEqual({
    value: 0, threshold: 0.28, fail: true,
    say: "under half the target: Claude ran 0%/h for the last 2 h and 0%/h for the last hour against a 0.55%/h target (alarm under 0.28%/h for 2 h or over 1.1%/h for 1 h); target = (100% of the new week left − 8% reserve) / 167 h until the reset Thu 13:00 IST (the last reading's week reset at Thu 13:00 IST, no reading since)",
  });
  // A request in the new week shows up as a new cycle, and its use counts.
  expect(burnVerdict([base(0.97, "a", old), at(90, 0.01, "a", old + 7 * 86400), at(105, 0.02, "a", old + 7 * 86400)], reserve, NOW).value).toBe(1);
});

test("at or under the reserve the target is 0: any use in the last hour is an over-run", () => {
  const nearlyOut = (u: number) => [base(0.93), at(105, u)];
  expect(burnVerdict(nearlyOut(0.93), reserve, NOW)).toMatchObject({ value: 0, fail: false });
  const v = burnVerdict(nearlyOut(0.94), reserve, NOW);
  expect(v.fail).toBe(true);
  expect(v.say).toContain("target = (6% of the week left − 8% reserve) / 37 h until the reset Sat 03:00 IST, 0 at or under the reserve");
});

test("summer resets say IDT", () => {
  const now = Date.parse("2026-06-10T12:00:00Z") / 1000, reset = now + 37 * 3600;
  const v = burnVerdict([{ account: "a", base: 1, bucket: 0, u: 0.55, reset, at: now - 8000 }], reserve, now);
  expect(v.say).toContain("until the reset Fri 04:00 IDT");
});

test("the reserve: orc's reserve_pct, else the default 8 and the line says the default is in use", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/burn-"));
  const path = join(dir, "burn-target.json");
  expect(DEFAULT_RESERVE_PCT).toBe(8);
  expect(readReserve(join(dir, "missing.json"))).toEqual({ pct: 8, from: "default, no burn-target.json" });
  // Today's file: the old constant target, no reserve_pct.
  writeFileSync(path, JSON.stringify({ pct_per_hour: 3, set_by: "orc", until: "2026-11-20T00:00:00Z" }));
  expect(readReserve(path)).toEqual({ pct: 8, from: "default, no reserve_pct in burn-target.json" });
  expect(burnVerdict(usage(0), readReserve(path), NOW).say).toContain("− 8% reserve (default, no reserve_pct in burn-target.json))");
  writeFileSync(path, JSON.stringify({ reserve_pct: 12.5, set_by: "orc" }));
  expect(readReserve(path)).toEqual({ pct: 12.5, from: "file" });
  for (const bad of ['{"reserve_pct": "8"}', '{"reserve_pct": -1}', '{"reserve_pct": 100}', "{"]) {
    writeFileSync(path, bad);
    expect(() => readReserve(path)).toThrow();
  }
});

test("rises add across accounts; a switch to a fresh account counts both", () => {
  // Account a used 2 points then idle; b picks up and uses 3 more.
  expect(burnRise([base(0.9, "a"), at(15, 0.92, "a"), base(0.1, "b"), at(60, 0.11, "b"), at(105, 0.13, "b")], START)).toBe(0.05);
  // An idle account with an older, higher reading adds nothing.
  expect(burnRise([base(0.95, "a"), base(0.2, "b"), at(30, 0.24, "b")], START)).toBe(0.04);
});

test("a later window starts from the last reading at or before it", () => {
  const pts = [base(0.5), at(15, 0.52), at(55, 0.53), at(75, 0.56), at(105, 0.57)];
  expect(burnRise(pts, START)).toBe(0.07);
  expect(burnRise(pts, START + 3600)).toBe(0.04);
});

test("a weekly reset inside the window counts the new week's use; a fall alone counts nothing", () => {
  const oldReset = START + 1800, newReset = oldReset + 7 * 86400;
  expect(burnRise([base(0.97, "a", oldReset), at(45, 0.03, "a", newReset), at(90, 0.05, "a", newReset)], START)).toBe(0.05);
  // The new week began before the window: its pre-window use is unknown, only the in-window rise counts.
  expect(burnRise([base(0.97, "a", START - 3600), at(45, 0.10, "a", START - 3600 + 7 * 86400), at(90, 0.12, "a", START - 3600 + 7 * 86400)], START)).toBe(0.02);
  expect(burnRise([base(0.50), at(30, 0.49)], START)).toBe(0);
});

test("quota cycles in one bucket retain chronological order even if result rows are reversed", () => {
  const oldReset = START + 7 * 60;
  const old = { ...at(2, 0.99, "a", oldReset), bucket: START };
  const fresh = { ...at(10, 0.03, "a", oldReset + 7 * 86400), bucket: START };
  const points = [base(0.97, "a", oldReset), fresh, old];
  expect(burnRise(points, START)).toBe(0.05);
  const v = burnVerdict(points, reserve, NOW);
  expect(v.value).toBe(2.5);
  expect(v.say).toContain("97% of the week");
});

test("SQL keeps in-window quota cycles separate but retains only the last baseline", () => {
  const sql = burnSQL(NOW);
  expect(sql).toContain("if(base = 1, 0, wreset) AS cycle");
  expect(sql).toContain("GROUP BY account, base, bucket, cycle");
  expect(sql).toContain("ORDER BY account, base DESC, bucket, reset");
});
