import { expect, test } from "bun:test";
import { allowed, plan, usable, type Observation } from "../../src/fable/core";
import { models, state, observed } from "./fixtures";

test("mode table preserves every available model except documented reserve/wait conflicts", () => {
  const now = Date.now();
  const variants: Partial<Observation>[] = [
    {},
    { disabled: true },
    { status: "error" },
    { unavailable: true },
    { cooldowns: [{ scope: "credential", remaining_seconds: 60 }] },
    ...models.map((model_key) => ({
      cooldowns: [{ scope: "model", model_key, remaining_seconds: 60 }],
    })),
  ];
  let rows = 0;
  for (const mode of ["off", "manual"] as const)
    for (const strict of [false, true])
      for (const spillover of [false, true])
        for (const override of [false, true])
          for (const reserve of [false, true])
            for (const swap of [false, true])
              for (const av of variants)
                for (const bv of variants) {
                  const s = {
                    ...state(),
                    mode,
                    strictFableAccount: strict,
                    spillover,
                    fableAccount: swap ? "b" : "a",
                    allowNonFableOnFableAccount: override,
                  };
                  const obs = [
                    { ...observed("a", reserve ? 0.7 : 0.2), ...av },
                    { ...observed("b"), ...bv },
                  ];
                  const p = plan(s, obs, now);
                  for (const model of models) {
                    if (
                      p.exceptions[model] ||
                      !obs.some((c) => usable(s, c, model, now))
                    )
                      continue;
                    expect(
                      obs.some(
                        (c) =>
                          usable(s, c, model, now) &&
                          allowed(models, p.desired[c.id]).includes(model),
                      ),
                    ).toBe(true);
                  }
                  rows++;
                }
  expect(rows).toBe(4096);
});
test("reserve defaults, persisted override, conservative fallback and stale weekly fail-open", () => {
  const s = state();
  expect(s.strictFableAccount).toBe(false);
  expect(s.fableReserveOnA).toBe(true);
  const a = { ...observed("a", 0.5), model_quotas: {} };
  const p = plan(s, [a, observed("b")]);
  expect(p.reserve).toEqual({
    nonFableEstimate: 0.5,
    triggered: true,
    confidence: "conservative",
  });
  expect(p.desired.a.excluded_models).toContain(models[1]);
  const override = plan({ ...s, allowNonFableOnFableAccount: true }, [
    a,
    observed("b"),
  ]);
  expect(override.desired.a.excluded_models).toBeNull();
  const stale = plan(s, [
    { ...a, quota: { ...a.quota!, observed_at: "2000-01-01" } },
    observed("b"),
  ]);
  expect(stale.applied).toBe("UNKNOWN");
  expect(stale.desired.a).toEqual({ excluded_models: null, priority: null });
});
test("cap wait, spillover, no upstream, literal model matching and unsupported auto", () => {
  const s = state(),
    a = observed("a", 0.2, 1),
    b = observed("b");
  expect(plan(s, [a, b]).applied).toBe("ON_WAIT_AT_CAP");
  expect(
    plan({ ...s, spillover: true }, [a, b]).desired.b.excluded_models,
  ).toBeNull();
  const p = plan(s, [
    { ...a, disabled: true },
    { ...b, disabled: true },
  ]);
  expect(p.exceptions[models[0]]).toBe("NO_UPSTREAM");
  expect(p.desired.b.excluded_models).toBeNull();
  expect(
    allowed(["x.1", "xa1"], { excluded_models: ["x.1"], priority: null }),
  ).toEqual(["xa1"]);
  expect(() => plan({ ...s, mode: "auto" }, [a, b])).toThrow("not enabled");
});
