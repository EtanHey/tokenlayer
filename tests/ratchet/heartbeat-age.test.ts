import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HEARTBEAT_WAKE_GRACE_S, heartbeatAge } from "../../ratchet/heartbeat-age";
import { plan, type Row } from "../../ratchet/live-schedule";

// What the M4 answers over ssh: last wake, boot and its clock (the same probe as usage_json_age_s, without usage.json).
const NOW = Date.parse("2026-11-19T16:00:00Z");
const sec = (iso: string) => Date.parse(iso) / 1000;
const awake = (wake = "2026-11-19T09:00:00Z", boot = "2026-11-10T00:00:00Z") => ({
  exitCode: 0,
  stderr: "",
  stdout: [`wake { sec = ${sec(wake)}, usec = 512 } Thu Nov 19 09:00:00 2026`, `boot { sec = ${sec(boot)}, usec = 0 } Tue Nov 10 00:00:00 2026`, `now ${NOW / 1000}`].join("\n"),
});
const asleep = { exitCode: 255, stdout: "", stderr: "ssh: connect to host macbook-pro port 22: Operation timed out" };

const rows = JSON.parse(readFileSync("ratchet/rows.json", "utf8")).rows as Row[];
const row = (id: string) => rows.find((r) => r.id === id)!;

test("both Macs have a heartbeat row; the M4's fails past 15 min of silence while awake", () => {
  for (const machine of ["m1", "m4"]) {
    expect(row(`ship_heartbeat_age_s_${machine}`)).toMatchObject({
      runner: "m1", direction: "max", ceiling: 900, unit: "s", command: `bun ratchet/live.ts ship_heartbeat_age_s_${machine}`,
    });
  }
});

test("dead shipper: the M4 is awake for hours and its last heartbeat is 20 min old → the age, and the row fails", () => {
  const age = heartbeatAge(awake(), { ageS: 1200 });
  expect(age).toBe(1200);
  const { state, lines } = plan([{ row: row("ship_heartbeat_age_s_m4"), value: age }], {}, new Date(NOW));
  expect(state).toEqual({ ship_heartbeat_age_s_m4: "fail" });
  expect(lines).toEqual(["### tokenlayer-ratchet → @tokenlayer-lead @orc — 2026-11-19T16:00:00Z FAIL ship_heartbeat_age_s_m4: value 1200, threshold ≤ 900 s"]);
});

test("asleep: an unreachable M4 is skipped however old its heartbeat, so the row stays quiet", () => {
  for (const stderr of ["ssh: connect to host macbook-pro port 22: Operation timed out", "ssh: Could not resolve hostname macbook-pro: nodename nor servname provided",
    "ssh: connect to host macbook-pro port 22: No route to host", "ssh: connect to host macbook-pro port 22: Host is down"])
    expect(heartbeatAge({ exitCode: 255, stdout: "", stderr }, { ageS: 6 * 3600 })).toBe("skip");
  expect(heartbeatAge(asleep, { ageS: null })).toBe("skip");
  const { state, lines } = plan([{ row: row("ship_heartbeat_age_s_m4"), value: heartbeatAge(asleep, { ageS: 6 * 3600 }) }], {}, new Date(NOW));
  expect({ state, lines }).toEqual({ state: {}, lines: [] });
});

test("just after a wake the pre-sleep heartbeat is skipped until the shipper has had time to beat", () => {
  const woke = new Date(NOW - (HEARTBEAT_WAKE_GRACE_S - 10) * 1000).toISOString();
  expect(heartbeatAge(awake(woke), { ageS: 6 * 3600 })).toBe("skip");
  expect(heartbeatAge(awake(woke), { ageS: null })).toBe("skip");
  // A heartbeat written since the wake is real data, even inside the grace.
  expect(heartbeatAge(awake(woke), { ageS: 20 })).toBe(20);
  // A fresh boot counts as a wake.
  expect(heartbeatAge(awake("2026-11-01T00:00:00Z", woke), { ageS: 6 * 3600 })).toBe("skip");
  // Past the grace a shipper that never beat is dead: the age is reported and trips.
  const longAgo = new Date(NOW - (HEARTBEAT_WAKE_GRACE_S + 900 + 60) * 1000).toISOString();
  expect(heartbeatAge(awake(longAgo), { ageS: 6 * 3600 })).toBe(6 * 3600);
});

test("a reachable Mac with no heartbeat at all, or a broken ssh probe, is MISSING (a real FAIL)", () => {
  expect(heartbeatAge(awake(), { ageS: null })).toBeNull();
  expect(heartbeatAge({ exitCode: 255, stdout: "", stderr: "fixture@macbook-pro: Permission denied (publickey)." }, { ageS: 30 })).toBeNull();
  expect(heartbeatAge({ exitCode: null, stdout: "", stderr: "" }, { ageS: 30 })).toBeNull();
});

test("the M1 row has no probe: the M1 runs the row, so it is always awake", () => {
  expect(heartbeatAge("local", { ageS: 12.5 })).toBe(12.5);
  expect(heartbeatAge("local", { ageS: 1200 })).toBe(1200);
  expect(heartbeatAge("local", { ageS: null })).toBeNull();
});

test("dead, then asleep, then dead again, then recovered: one FAIL line and one cleared line", () => {
  const r = row("ship_heartbeat_age_s_m4");
  const runs = [
    heartbeatAge(awake(), { ageS: 1200 }), // awake, shipper dead → FAIL
    heartbeatAge(asleep, { ageS: 2400 }), // lid closed → held, nothing posted
    heartbeatAge(awake(), { ageS: 3600 }), // awake again, still dead → still fail, nothing posted
    heartbeatAge(awake(), { ageS: 15 }), // shipper restarted → cleared
    heartbeatAge(awake(), { ageS: 12 }), // healthy → nothing posted
  ];
  let previous = {};
  const posted: string[] = [];
  const states: string[] = [];
  for (const value of runs) {
    const { state, lines } = plan([{ row: r, value }], previous, new Date(NOW));
    posted.push(...lines);
    states.push(state[r.id] ?? "none");
    previous = state;
  }
  expect(states).toEqual(["fail", "fail", "fail", "pass", "pass"]);
  expect(posted.map((l) => l.replace(/^.* (FAIL|cleared) /, "$1 "))).toEqual([
    "FAIL ship_heartbeat_age_s_m4: value 1200, threshold ≤ 900 s",
    "cleared ship_heartbeat_age_s_m4: value 15, threshold ≤ 900 s",
  ]);
});
