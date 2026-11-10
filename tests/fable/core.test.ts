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
                    const a = obs[swap ? 1 : 0],
                      b = obs[swap ? 0 : 1];
                    const au = usable(s, a, model, now),
                      bu = usable(s, b, model, now);
                    // Expected exceptions are derived independently from fixture inputs, never skipped by label.
                    const reserveOnA =
                      (swap ? 0.1 : reserve ? 0.6 : 0.1) >= 0.45;
                    const expected =
                      mode === "off"
                        ? undefined
                        : !au && !bu
                          ? "NO_UPSTREAM"
                          : model !== models[0] &&
                              reserveOnA &&
                              !override &&
                              !bu
                            ? "RESERVE_CONFLICT"
                            : undefined;
                    expect<string | null>(p.exceptions[model] ?? null).toBe(
                      expected ?? null,
                    );
                    const routed = obs.some(
                      (c) =>
                        usable(s, c, model, now) &&
                        allowed(models, p.desired[c.id]).includes(model),
                    );
                    expect(routed).toBe(
                      (au || bu) && expected !== "RESERVE_CONFLICT",
                    );
                    if (expected === "NO_UPSTREAM")
                      for (const c of obs)
                        expect(allowed(models, p.desired[c.id])).toContain(
                          model,
                        );
                  }
                  rows++;
                }
  expect(rows).toBe(4096);
});
test("reserve defaults, override, conservative fallback; stale A degrades and stale B fails open", () => {
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
  expect(stale.applied).toBe("DEGRADED");
  expect(allowed(models, stale.desired.b)).toContain(models[0]);
  const staleB = plan(s, [
    observed("a"),
    {
      ...observed("b"),
      quota: { ...observed("b").quota!, observed_at: "2000-01-01" },
    },
  ]);
  expect(staleB.applied).toBe("UNKNOWN");
  expect(staleB.desired.a).toEqual({ excluded_models: null, priority: null });
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

test("reserve boundary .44/.449/.45 and override during conflict", () => {
  for (const [n, triggered] of [
    [0.44, false],
    [0.449, false],
    [0.45, true],
  ] as const) {
    const s = state(),
      obs = [observed("a", n, 0), { ...observed("b"), status: "error" }];
    const p = plan(s, obs);
    expect(p.reserve?.triggered).toBe(triggered);
    expect<string | null>(p.exceptions[models[1]] ?? null).toBe(
      triggered ? "RESERVE_CONFLICT" : null,
    );
    expect(
      plan({ ...s, allowNonFableOnFableAccount: true }, obs).desired.a
        .excluded_models,
    ).toBeNull();
  }
});
test("rejected Fable cap with model cooldown waits only when spillover is off", () => {
  const a = observed("a", 0.2, 0.4),
    b = observed("b"),
    s = state();
  a.model_quotas![models[0]].signals![
    "Anthropic-Ratelimit-Unified-7d_oi-Status"
  ] = "rejected";
  a.cooldowns = [
    { scope: "model", model_key: models[0], remaining_seconds: 60 },
  ];
  const wait = plan(s, [a, b]);
  expect(wait.applied).toBe("ON_WAIT_AT_CAP");
  expect(wait.exceptions[models[0]]).toBe("WAIT_AT_CAP");
  expect(allowed(models, wait.desired.b)).not.toContain(models[0]);
  const spill = plan({ ...s, spillover: true }, [a, b]);
  expect(allowed(models, spill.desired.b)).toContain(models[0]);
});

test("quota exception rows pin E1/E2 and reserve labels with routing postconditions", () => {
  for (const spillover of [false, true])
    for (const quota of [
      "cap-rejected",
      "cap-utilization",
      "week-rejected",
      "stale-fable",
    ])
      for (const bError of [false, true]) {
        const s = { ...state(), spillover },
          a = observed("a"),
          b = observed("b");
        const cap = quota.startsWith("cap");
        if (quota === "cap-rejected")
          a.model_quotas![models[0]].signals![
            "Anthropic-Ratelimit-Unified-7d_oi-Status"
          ] = "rejected";
        if (quota === "cap-utilization")
          a.model_quotas![models[0]].signals![
            "Anthropic-Ratelimit-Unified-7d_oi-Utilization"
          ] = "0.99";
        if (quota === "week-rejected")
          a.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Status"] =
            "rejected";
        if (quota === "stale-fable")
          a.model_quotas = {
            [models[0]]: {
              ...a.model_quotas![models[0]],
              observed_at: "2000-01-01",
            },
          };
        if (bError) b.status = "error";
        const p = plan(s, [a, b]);
        const exception = bError
          ? "NO_UPSTREAM"
          : cap && !spillover
            ? "WAIT_AT_CAP"
            : null;
        expect<string | null>(p.exceptions[models[0]] ?? null).toBe(exception);
        expect(
          [a, b].some(
            (c) =>
              usable(s, c, models[0]) &&
              allowed(models, p.desired[c.id]).includes(models[0]),
          ),
        ).toBe(exception === null);
        if (exception === "NO_UPSTREAM")
          for (const c of [a, b])
            expect(allowed(models, p.desired[c.id])).toContain(models[0]);
        else if (exception === "WAIT_AT_CAP")
          expect(p.applied).toBe("ON_WAIT_AT_CAP");
        else if (!cap) expect(p.applied).toBe("DEGRADED");
      }
});

test("a rejected cap signal remains a real cap without utilization", () => {
  const a = observed("a");
  a.model_quotas![models[0]].signals![
    "Anthropic-Ratelimit-Unified-7d_oi-Status"
  ] = "rejected";
  delete a.model_quotas![models[0]].signals![
    "Anthropic-Ratelimit-Unified-7d_oi-Utilization"
  ];
  const p = plan(state(), [a, observed("b")]);
  expect(p.applied).toBe("ON_WAIT_AT_CAP");
  expect(p.exceptions[models[0]]).toBe("WAIT_AT_CAP");
});
