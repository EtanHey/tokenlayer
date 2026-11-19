import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { burnRise, burnVerdict, readTarget, type Point } from "../../ratchet/burn";
import { liveRows, plan } from "../../ratchet/live-schedule";

const rows = JSON.parse(readFileSync("ratchet/rows.json", "utf8")).rows;
const PREFIX = "### tokenlayer-ratchet → @tokenlayer-lead @orc — ";
const NOW = Date.parse("2026-11-19T12:00:00Z") / 1000;
const START = NOW - 7200;
const RESET = Date.parse("2026-11-20T19:00:00Z") / 1000; // Fri 21:00 in Israel
const target = { pct_per_hour: 3, set_by: "orc", until: "2026-11-20T19:00:00Z" };
const base = (u: number, account = "a", reset = RESET): Point => ({ account, base: 1, bucket: 0, u, reset, at: START - 600 });
const at = (min: number, u: number, account = "a", reset = RESET): Point => ({ account, base: 0, bucket: START + min * 60, u, reset, at: START + min * 60 + 30 });
/** One reading per 15-minute bucket across the window, rising `perHour` points an hour from 0.55. */
const usage = (perHour: number) => [base(0.55), ...Array.from({ length: 8 }, (_, i) => at(i * 15, Math.round((0.55 + perHour / 100 * (i + 1) / 4) * 100) / 100))];

test("flat usage (07:00–14:28 IST on 19 Nov) trips the row and says rate, target, window and week left", () => {
  const v = burnVerdict(usage(0), target, NOW);
  expect(v).toEqual({ value: 0, threshold: 1.5, say: "Claude ran 0%/h for the last 2 h against a 3%/h target (alarm under 1.5%/h); 45% of the week is left until Fri 21:00" });
  const row = liveRows(rows).find((r) => r.id === "claude_burn_2h")!;
  const { lines, state } = plan([{ row, ...v }], {}, new Date(NOW * 1000));
  expect(state.claude_burn_2h).toBe("fail");
  expect(lines).toEqual([`${PREFIX}2026-11-19T12:00:00Z FAIL claude_burn_2h: ${v.say}`]);
});

test("usage on target clears the row with one cleared line", () => {
  const v = burnVerdict(usage(3), target, NOW);
  expect(v.value).toBe(3);
  const row = liveRows(rows).find((r) => r.id === "claude_burn_2h")!;
  const { lines, state } = plan([{ row, ...v }], { claude_burn_2h: "fail" }, new Date(NOW * 1000));
  expect(state.claude_burn_2h).toBe("pass");
  expect(lines).toEqual([`${PREFIX}2026-11-19T12:00:00Z cleared claude_burn_2h: Claude ran 3%/h for the last 2 h against a 3%/h target (alarm under 1.5%/h); 39% of the week is left until Fri 21:00`]);
});

test("exactly half the target passes; just under it fails", () => {
  expect(burnVerdict([base(0.55), at(100, 0.58)], target, NOW).value).toBe(1.5);
  const row = liveRows(rows).find((r) => r.id === "claude_burn_2h")!;
  expect(plan([{ row, ...burnVerdict([base(0.55), at(100, 0.58)], target, NOW) }], {}, new Date(NOW * 1000)).state.claude_burn_2h).toBe("pass");
  expect(plan([{ row, ...burnVerdict([base(0.55), at(100, 0.57)], target, NOW) }], {}, new Date(NOW * 1000)).state.claude_burn_2h).toBe("fail");
});

test("no request at all in 2 h counts as 0%/h and trips the row", () => {
  const v = burnVerdict([base(0.55)], target, NOW);
  expect(v.value).toBe(0);
  expect(v.threshold).toBe(1.5);
  expect(burnVerdict([], target, NOW).say).toBe("Claude ran 0%/h for the last 2 h against a 3%/h target (alarm under 1.5%/h); no Claude request in 8 days");
});

test("no target file reports only: never fails, posts nothing, and says so", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/burn-"));
  expect(readTarget(join(dir, "missing.json"))).toBeNull();
  const v = burnVerdict(usage(0), null, NOW);
  expect(v.threshold).toBeNull();
  expect(v.say).toBe("Claude ran 0%/h for the last 2 h; no burn target set, report only; 45% of the week is left until Fri 21:00");
  const row = liveRows(rows).find((r) => r.id === "claude_burn_2h")!;
  expect(plan([{ row, ...v }], {}, new Date(NOW * 1000))).toEqual({ lines: [], state: { claude_burn_2h: "pass" }, reports: { claude_burn_2h: v.say } });
});

test("a target past its until reports only", () => {
  const v = burnVerdict(usage(0), { ...target, until: "2026-11-19T11:00:00Z" }, NOW);
  expect(v.threshold).toBeNull();
  expect(v.say).toContain("the 3%/h burn target expired at 2026-11-19T11:00:00Z, report only");
});

test("reads orc's target file; a malformed one is a broken probe, not a silent pass", () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/burn-"));
  const path = join(dir, "burn-target.json");
  writeFileSync(path, JSON.stringify(target));
  expect(readTarget(path)).toEqual(target);
  writeFileSync(path, JSON.stringify({ pct_per_hour: "3" }));
  expect(() => readTarget(path)).toThrow("pct_per_hour");
  writeFileSync(path, JSON.stringify({ pct_per_hour: 3, until: "Friday" }));
  expect(() => readTarget(path)).toThrow("until");
});

test("rises add across accounts; a switch to a fresh account counts both", () => {
  // Account a used 2 points then idle; b picks up and uses 3 more.
  expect(burnRise([base(0.9, "a"), at(15, 0.92, "a"), base(0.1, "b"), at(60, 0.11, "b"), at(105, 0.13, "b")], START)).toBe(0.05);
  // An idle account with an older, higher reading adds nothing.
  expect(burnRise([base(0.95, "a"), base(0.2, "b"), at(30, 0.24, "b")], START)).toBe(0.04);
});

test("a weekly reset inside the window counts the new week's use; a fall alone counts nothing", () => {
  const oldReset = START + 1800, newReset = oldReset + 7 * 86400;
  expect(burnRise([base(0.97, "a", oldReset), at(45, 0.03, "a", newReset), at(90, 0.05, "a", newReset)], START)).toBe(0.05);
  // The new week began before the window: its pre-window use is unknown, only the in-window rise counts.
  expect(burnRise([base(0.97, "a", START - 3600), at(45, 0.10, "a", START - 3600 + 7 * 86400), at(90, 0.12, "a", START - 3600 + 7 * 86400)], START)).toBe(0.02);
  expect(burnRise([base(0.50), at(30, 0.49)], START)).toBe(0);
});
