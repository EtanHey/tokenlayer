import { expect, test } from "bun:test";
import { allowed, plan, usable, type Observation } from "../../src/fable/core";
import { models, state, observed } from "./fixtures";

// F3: after a weekly reset, an idle account's Fable model quota keeps the old
// window's reading until a Fable request refreshes it.
const fable = models[0];
const now = Date.now(); // the fixtures stamp B's observations with the import time
const hour = 3600000;
const sec = (ms: number) => String(Math.floor(ms / 1000));
const P = "Anthropic-Ratelimit-Unified-";

function afterReset(o: {
  fableStatus?: string;
  fableReset?: number | null;
  fableObservedAt?: number;
  weekObservedAt?: number;
  weekReset?: number;
}): Observation {
  const a = observed("a");
  a.quota = {
    observed_at: new Date(o.weekObservedAt ?? now - 60000).toISOString(),
    signals: {
      [P + "7d-Utilization"]: "0.01",
      [P + "7d-Status"]: "allowed",
      [P + "7d-Reset"]: sec(o.weekReset ?? now + 7 * 24 * hour - 5 * 60000),
    },
  };
  const reset = o.fableReset === undefined ? now - 5 * 60000 : o.fableReset;
  a.model_quotas = {
    [fable]: {
      observed_at: new Date(o.fableObservedAt ?? now - 8 * 24 * hour).toISOString(),
      signals: {
        [P + "7d-Utilization"]: "1",
        [P + "7d-Status"]: "rejected",
        [P + "7d_oi-Utilization"]: "1",
        [P + "7d_oi-Status"]: o.fableStatus ?? "rejected",
        ...(reset === null
          ? {}
          : { [P + "7d-Reset"]: sec(reset), [P + "7d_oi-Reset"]: sec(reset) }),
      },
    },
  };
  return a;
}
// B cannot serve Fable (weekly exhausted), so a refusal on A is visible as NO_UPSTREAM.
const exhaustedB = () => observed("b", 0.98);

test("an expired Fable rejection with a fresh post-reset weekly signal is usable", () => {
  const a = afterReset({});
  expect(usable(state(), a, fable, now)).toBe(true);
  const p = plan(state(), [a, exhaustedB()], now);
  expect(p.exceptions).toEqual({});
  expect(p.applied).toBe("ON");
  expect(allowed(models, p.desired.a)).toContain(fable);
  expect(allowed(models, p.desired.b)).not.toContain(fable);
});

test("an expired stale allowed Fable reading (the F1 shape) is usable", () => {
  const a = afterReset({ fableStatus: "allowed" });
  a.model_quotas![fable].signals![P + "7d_oi-Utilization"] = "0";
  expect(usable(state(), a, fable, now)).toBe(true);
  expect(plan(state(), [a, exhaustedB()], now).applied).toBe("ON");
});

test("a Fable rejection whose reset is still ahead keeps refusing", () => {
  for (const fableObservedAt of [now - 60000, now - 2 * 24 * hour]) {
    const a = afterReset({ fableReset: now + hour, fableObservedAt });
    expect(usable(state(), a, fable, now)).toBe(false);
    const p = plan(state(), [a, exhaustedB()], now);
    expect(p.exceptions[fable]).toBe("NO_UPSTREAM");
    expect(p.applied).toBe("DEGRADED");
  }
});

test("an expired Fable rejection with a stale weekly signal keeps refusing", () => {
  const a = afterReset({ weekObservedAt: now - hour });
  expect(usable(state(), a, fable, now)).toBe(false);
  expect(plan(state(), [a, exhaustedB()], now).exceptions[fable]).toBe(
    "NO_UPSTREAM",
  );
});

test("a fresh weekly signal that has not moved past the Fable reset keeps refusing", () => {
  const reset = now - 5 * 60000;
  const a = afterReset({ fableReset: reset, weekReset: reset });
  expect(usable(state(), a, fable, now)).toBe(false);
});

test("a stale Fable rejection without a reset time keeps refusing", () => {
  const a = afterReset({ fableReset: null });
  expect(usable(state(), a, fable, now)).toBe(false);
});

test("an expired Fable rejection is no longer a cap (no WAIT_AT_CAP)", () => {
  const a = afterReset({});
  a.cooldowns = [{ scope: "model", model_key: fable, remaining_seconds: 60 }];
  const p = plan(state(), [a, observed("b")], now);
  expect(p.exceptions[fable]).toBeUndefined();
  expect(p.applied).toBe("DEGRADED");
  expect(allowed(models, p.desired.b)).toContain(fable);
});

for (const [name, overrides] of [
  ["rejection observed after reset", { fableObservedAt: now - 1000 }],
  ["rejection observed at reset", { fableObservedAt: Math.floor((now - 300000) / 1000) * 1000 }],
  ["weekly observation before reset", { weekObservedAt: now - 4 * 60000, fableReset: now - 2 * 60000 }],
  ["weekly observation at reset", { fableReset: now - 120000, weekObservedAt: Math.floor((now - 120000) / 1000) * 1000 }],
  ["weekly reset also past", { weekReset: now - 60000 }],
] as const) {
  test(`expiry refuses ${name} and preserves cap policy`, () => {
    const a = afterReset(overrides);
    const s = state();
    s.spillover = false;
    expect(usable(s, a, fable, now)).toBe(false);
    expect(plan(s, [a, exhaustedB()], now).exceptions[fable]).toBe("NO_UPSTREAM");
    a.cooldowns = [{ scope: "model", model_key: fable, remaining_seconds: 60 }];
    const p = plan(s, [a, observed("b")], now);
    expect(p.exceptions[fable]).toBe("WAIT_AT_CAP");
    expect(allowed(models, p.desired.b)).not.toContain(fable);
  });
}
