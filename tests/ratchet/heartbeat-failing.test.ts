import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FAILING_WINDOW_S, heartbeatFailing, heartbeatFailingSQL, type FailingWindow } from "../../ratchet/heartbeat-age";
import { plan, type Measured, type Row } from "../../ratchet/live-schedule";

// What the M4 answers over ssh: last wake, boot and its clock (H1's probe, shared with usage_json_age_s).
const NOW = Date.parse("2026-11-19T16:00:00Z");
const sec = (iso: string) => Date.parse(iso) / 1000;
const awake = (wake = "2026-11-19T09:00:00Z", boot = "2026-11-10T00:00:00Z") => ({
  exitCode: 0,
  stderr: "",
  stdout: [`wake { sec = ${sec(wake)}, usec = 512 } Thu Nov 19 09:00:00 2026`, `boot { sec = ${sec(boot)}, usec = 0 } Tue Nov 10 00:00:00 2026`, `now ${NOW / 1000}`].join("\n"),
});
const asleep = { exitCode: 255, stdout: "", stderr: "ssh: connect to host macbook-pro port 22: Operation timed out" };
const wokeAgo = (s: number) => awake(new Date(NOW - s * 1000).toISOString());

const rows = JSON.parse(readFileSync("ratchet/rows.json", "utf8")).rows as Row[];
const row = (id: string) => rows.find((r) => r.id === id)!;
const result = (id: string, m: Measured | "skip") => (m === "skip" ? { row: row(id), value: "skip" as const } : { row: row(id), ...m });

// A daemon failing every pass writes one error beat a minute (H1's Heartbeat), so 15 in the window.
const allFailing: FailingWindow = { n: 15, ok: 0, classes: ["file_errors"] };
// One good pass among the failures: the class changed, so the ok beat was written at once.
const mixed: FailingWindow = { n: 16, ok: 1, classes: ["file_errors"] };
const healthy: FailingWindow = { n: 15, ok: 15, classes: [] };
const empty: FailingWindow = { n: 0, ok: 0, classes: [] };

test("both Macs have a failing row: no heartbeat in the window may be ok, judged every 15-min run", () => {
  expect(FAILING_WINDOW_S).toBe(900);
  for (const machine of ["m1", "m4"]) {
    expect(row(`ship_heartbeat_failing_${machine}`)).toMatchObject({
      runner: "m1", direction: "max", ceiling: 0, command: `bun ratchet/live.ts ship_heartbeat_failing_${machine}`,
    });
  }
  expect(heartbeatFailingSQL("m4")).toContain("machine = 'm4'");
  expect(heartbeatFailingSQL("m4")).toContain(`INTERVAL ${FAILING_WINDOW_S} SECOND`);
});

test("all failing: every beat in the last 15 min carries an error class → the row fails and names the classes", () => {
  for (const probe of ["local", awake()] as const) {
    const m = heartbeatFailing(probe, allFailing);
    expect(m).toEqual({ value: 15, threshold: 0, say: "all 15 heartbeats in the last 15 min failed (file_errors): the shipper runs, but no pass succeeds" });
  }
  const { state, lines } = plan([result("ship_heartbeat_failing_m1", heartbeatFailing("local", allFailing))], {}, new Date(NOW));
  expect(state).toEqual({ ship_heartbeat_failing_m1: "fail" });
  expect(lines).toEqual(["### tokenlayer-ratchet → @tokenlayer-lead @orc — 2026-11-19T16:00:00Z FAIL ship_heartbeat_failing_m1: all 15 heartbeats in the last 15 min failed (file_errors): the shipper runs, but no pass succeeds"]);
  // Classes change under an outage; still all failing.
  expect(heartbeatFailing("local", { n: 3, ok: 0, classes: ["other", "store_unreachable"] })).toMatchObject({ value: 3, say: expect.stringContaining("(other, store_unreachable)") });
});

test("mixed: one ok pass in the window → passes, nothing posted", () => {
  const m = heartbeatFailing(awake(), mixed);
  expect(m).toEqual({ value: 0, threshold: 0, say: "1 of 16 heartbeats in the last 15 min ok" });
  const { state, lines } = plan([result("ship_heartbeat_failing_m4", m)], {}, new Date(NOW));
  expect({ state, lines }).toEqual({ state: { ship_heartbeat_failing_m4: "pass" }, lines: [] });
});

test("no beat in the window is the age row's job: hold the state, never clear or post", () => {
  expect(heartbeatFailing("local", empty)).toBe("skip");
  expect(heartbeatFailing(awake(), empty)).toBe("skip");
});

test("H1's sleeping-M4 rule: asleep, off the tailnet, freshly woken or a broken probe → skip", () => {
  expect(heartbeatFailing(asleep, allFailing)).toBe("skip");
  expect(heartbeatFailing({ exitCode: 255, stdout: "", stderr: "ssh: Could not resolve hostname macbook-pro: nodename nor servname provided" }, allFailing)).toBe("skip");
  // Under a full window since the wake, part of the window is passes from before the network came back.
  expect(heartbeatFailing(wokeAgo(FAILING_WINDOW_S - 10), allFailing)).toBe("skip");
  expect(heartbeatFailing(awake("2026-11-01T00:00:00Z", new Date(NOW - 60_000).toISOString()), allFailing)).toBe("skip");
  expect(heartbeatFailing(wokeAgo(FAILING_WINDOW_S + 10), allFailing)).toMatchObject({ value: 15 });
  // A refused key is the age row's MISSING; this row cannot apply the wake rule, so it holds.
  expect(heartbeatFailing({ exitCode: 255, stdout: "", stderr: "fixture@macbook-pro: Permission denied (publickey)." }, allFailing)).toBe("skip");
  expect(heartbeatFailing({ exitCode: null, stdout: "", stderr: "" }, allFailing)).toBe("skip");
});

test("failing, asleep, failing, recovered: one FAIL line and one cleared line", () => {
  const id = "ship_heartbeat_failing_m4";
  const runs = [
    heartbeatFailing(awake(), allFailing), // awake, every pass failing → FAIL
    heartbeatFailing(asleep, empty), // lid closed → held, nothing posted
    heartbeatFailing(wokeAgo(120), allFailing), // just woke → held
    heartbeatFailing(awake(), allFailing), // still failing → still fail, nothing posted
    heartbeatFailing(awake(), mixed), // a pass succeeded → cleared
    heartbeatFailing(awake(), healthy), // healthy → nothing posted
  ];
  let previous = {};
  const posted: string[] = [];
  const states: string[] = [];
  for (const m of runs) {
    const { state, lines } = plan([result(id, m)], previous, new Date(NOW));
    posted.push(...lines);
    states.push(state[id] ?? "none");
    previous = state;
  }
  expect(states).toEqual(["fail", "fail", "fail", "fail", "pass", "pass"]);
  expect(posted.map((l) => l.replace(/^.* (FAIL|cleared) /, "$1 "))).toEqual([
    "FAIL ship_heartbeat_failing_m4: all 15 heartbeats in the last 15 min failed (file_errors): the shipper runs, but no pass succeeds",
    "cleared ship_heartbeat_failing_m4: 1 of 16 heartbeats in the last 15 min ok",
  ]);
});
