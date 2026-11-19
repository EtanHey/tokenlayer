import { expect, test } from "bun:test";
import { plan, usable, type Observation } from "../../src/fable/core";
import { observe } from "../../src/fable/io";
import { weeklyHistory } from "../../src/fable/history";
import { labelHash } from "../../src/lib/hash";
import { fakeHub, models, observed, state } from "./fixtures";

// F4: the hub learns weekly use only from responses it serves. An idle credential (or every
// credential after a hub restart) has no weekly reading at all, so ON planned UNKNOWN.
const now = Date.now();
const hour = 3600000;
const opus = models[1];

/** The live 2026-11-19 shape: the hub has no reading for B; history may hold its last one. */
function idleB(last?: { u: number; reset: number; status?: string }): Observation {
  const b = observed("b");
  b.quota = { signals: {} } as Observation["quota"];
  b.model_quotas = {};
  if (last)
    b.last_weekly = {
      u: last.u,
      reset: last.reset,
      status: last.status ?? "allowed",
      observed_at: new Date(now - 27 * hour).toISOString(),
    };
  return b;
}

test("no hub reading and no history keeps planning UNKNOWN", () => {
  const p = plan(state(), [observed("a"), idleB()], now);
  expect(p.applied).toBe("UNKNOWN");
});

test("a last reading whose reset has passed is an estimated new window: usable, ON", () => {
  const b = idleB({ u: 0.95, reset: now - hour, status: "allowed_warning" });
  expect(usable(state(), b, opus, now)).toBe(true);
  const p = plan(state(), [observed("a"), b], now);
  expect(p.applied).toBe("ON");
  expect(p.desired.a.priority).toBe(50);
  expect(p.desired.b.priority).toBe(100);
  expect(p.weeklyEstimated).toEqual({ b: "new-window" });
  expect(p.reason).toContain("estimated");
});

test("a last reading at the exhausted threshold whose reset is ahead is exhausted, not UNKNOWN", () => {
  // Live etanface: 0.95 allowed_warning at 2026-11-18 10:09Z, reset Sun 2026-11-22 02:00Z.
  const b = idleB({ u: 0.95, reset: now + 60 * hour, status: "allowed_warning" });
  expect(usable(state(), b, opus, now)).toBe(false);
  const p = plan(state(), [observed("a"), b], now);
  expect(p.applied).toBe("ON");
  expect(p.weeklyEstimated).toEqual({ b: "exhausted" });
});

test("a rejected last reading whose reset is ahead is exhausted", () => {
  const b = idleB({ u: 0.5, reset: now + hour, status: "rejected" });
  expect(usable(state(), b, opus, now)).toBe(false);
  expect(plan(state(), [observed("a"), b], now).weeklyEstimated).toEqual({ b: "exhausted" });
});

test("a last reading below the threshold in the current window stays UNKNOWN (only a lower bound)", () => {
  const b = idleB({ u: 0.3, reset: now + 60 * hour });
  expect(usable(state(), b, opus, now)).toBe(false);
  expect(plan(state(), [observed("a"), b], now).applied).toBe("UNKNOWN");
});

test("a present hub reading, even stale, wins over history", () => {
  const b = idleB({ u: 0.1, reset: now - hour });
  b.quota = { ...observed("b").quota!, observed_at: new Date(now - hour).toISOString() };
  expect(plan(state(), [observed("a"), b], now).applied).toBe("UNKNOWN");
  const fresh = idleB({ u: 0.99, reset: now + hour, status: "rejected" });
  fresh.quota = observed("b").quota;
  expect(usable(state(), fresh, opus, now)).toBe(true);
  expect(plan(state(), [observed("a"), fresh], now).weeklyEstimated).toBeUndefined();
});

test("an estimated new window never makes Fable usable without a Fable reading", () => {
  const b = idleB({ u: 0.2, reset: now - hour });
  expect(usable(state(), b, models[0], now)).toBe(false);
});

test("a superseded snapshot (unconfirmed reset press) also drops history", () => {
  const s = state();
  const b = idleB({ u: 0.2, reset: now - hour });
  s.recovery = { b: { index: "b", checkedAt: now, result: "unconfirmed", superseded: [] } };
  expect(usable(s, b, opus, now)).toBe(false);
});

test("observe attaches history only to credentials the hub has no weekly reading for", async () => {
  const hub = fakeHub();
  hub.obs[1].quota = { signals: {} } as Observation["quota"];
  const asked: string[] = [];
  const last = { u: 0.95, reset: now - hour, status: "allowed", observed_at: new Date(now - 27 * hour).toISOString() };
  const obs = await observe(state(), { ...hub, lastWeekly: async (c: Observation) => (asked.push(c.id), last) });
  expect(asked).toEqual(["b"]);
  expect(obs.find((c) => c.id === "a")!.last_weekly).toBeUndefined();
  expect(obs.find((c) => c.id === "b")!.last_weekly).toEqual(last);
});

test("a failing history lookup leaves the credential without history", async () => {
  const hub = fakeHub();
  hub.obs[1].quota = { signals: {} } as Observation["quota"];
  const obs = await observe(state(), { ...hub, lastWeekly: async () => { throw Error("clickhouse down"); } });
  expect(obs.find((c) => c.id === "b")!.last_weekly).toBeUndefined();
});

test("weeklyHistory reads the exact weekly key for the hashed credential, newest first", async () => {
  const sql: string[] = [];
  const ch = {
    queryJSON: async (q: string) => (sql.push(q), [{ u: "0.95", reset: "1795312800", status: "allowed_warning", ms: "1795428584745" }]),
  };
  const last = await weeklyHistory(ch as never)(observed("b"));
  expect(last).toEqual({ u: 0.95, reset: 1795312800000, status: "allowed_warning", observed_at: new Date(1795428584745).toISOString() });
  expect(sql[0]).toContain(`credential = '${labelHash("b")}'`);
  expect(sql[0]).toContain("ratelimit['anthropic-ratelimit-unified-7d-utilization']");
  expect(sql[0]).not.toContain("7d_oi");
  expect(sql[0]).toContain("ORDER BY ts DESC LIMIT 1");
});

test("weeklyHistory returns nothing for no rows or an unreadable row", async () => {
  expect(await weeklyHistory({ queryJSON: async () => [] } as never)(observed("b"))).toBeUndefined();
  const bad = { queryJSON: async () => [{ u: "x", reset: "1795312800", status: "allowed", ms: "1" }] };
  expect(await weeklyHistory(bad as never)(observed("b"))).toBeUndefined();
});
