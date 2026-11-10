import { expect, test } from "bun:test";
import { execute } from "../../src/fable/io";
import { plan, allowed, usable } from "../../src/fable/core";
import { fakeHub, models, state } from "./fixtures";
const noop = () => {};
test("ambiguous committed writes read back; rejected writes stop; duplicates don't rewrite", async () => {
  const s = state(),
    hub = fakeHub(),
    patch = hub.patch;
  hub.patch = async (id, fields) => {
    await patch(id, fields);
    throw Error("committed then 500");
  };
  await execute(s, plan(s, hub.obs), hub, "one", noop, noop);
  expect(s.applied).toBe("ON");
  const n = hub.calls.length;
  await execute(s, plan(s, hub.obs), hub, "one", noop, noop);
  expect(hub.calls.length).toBe(n);
  s.mode = "off";
  hub.patch = async () => {
    throw Error("rejected");
  };
  await expect(
    execute(s, plan(s, hub.obs), hub, "two", noop, noop),
  ).rejects.toThrow("unconfirmed");
  expect(s.applied).toBe("UNKNOWN");
  expect(s.pending?.op).toBe("two");
});
test("health change after priority readback cannot strand Opus during strict restriction", async () => {
  const s = { ...state(), strictFableAccount: true },
    hub = fakeHub(),
    patch = hub.patch;
  hub.patch = async (id, fields) => {
    await patch(id, fields);
    if (fields.priority === 100)
      hub.obs[1].cooldowns = [
        { scope: "model", model_key: models[1], remaining_seconds: 60 },
      ];
  };
  await execute(s, plan(s, hub.obs), hub, "race", noop, noop);
  expect(hub.rules.a).not.toContain(models[1]);
  expect(hub.rules.a).toContain(models[2]);
});
test("every transition expands all before restricting, with an available route at every write", async () => {
  const violations: string[] = [];
  for (const health of ["healthy", "B-model-cooldown", "A-cap"])
    for (const from of ["off", "on", "strict", "reserve", "override", "swap"])
      for (const to of ["off", "on", "strict", "reserve", "override", "swap"]) {
        const s = state(),
          hub = fakeHub();
        const configure = (mode: string) => {
          s.mode = mode === "off" ? "off" : "manual";
          s.strictFableAccount = mode === "strict";
          s.fableAccount = mode === "swap" ? "b" : "a";
          s.allowNonFableOnFableAccount = mode === "override";
          s.reserveFraction = mode === "reserve" ? 0.1 : 0.5;
        };
        if (health === "B-model-cooldown")
          hub.obs[1].cooldowns = [
            { scope: "model", model_key: models[1], remaining_seconds: 60 },
          ];
        if (health === "A-cap") {
          hub.obs[0].model_quotas![models[0]].signals![
            "Anthropic-Ratelimit-Unified-7d_oi-Status"
          ] = "rejected";
        }
        const patch = hub.patch;
        hub.patch = async (id, fields) => {
          await patch(id, fields);
          const p = plan(s, hub.obs);
          for (const model of models) {
            if (p.exceptions[model]) continue;
            if (
              !hub.obs.some((c) =>
                usable(
                  s,
                  {
                    ...c,
                    catalog: allowed(models, {
                      excluded_models: hub.rules[c.id],
                      priority: c.priority ?? null,
                    }),
                  },
                  model,
                ),
              )
            )
              violations.push(`${health}:${from}->${to}:${id}:${model}`);
          }
        };
        configure(from);
        await execute(s, plan(s, hub.obs), hub, "from", noop, noop);
        configure(to);
        await execute(s, plan(s, hub.obs), hub, "to", noop, noop);
        expect(s.applied).toBe(plan(s, hub.obs).applied);
      }
  expect(violations).toEqual([]);
});

test("last-route guard rejects unsafe proof; route oracle survives caught PATCH failures", async () => {
  const s = state(),
    hub = fakeHub(),
    patch = hub.patch,
    violations: string[] = [];
  hub.obs[0].cooldowns = [
    { scope: "model", model_key: models[1], remaining_seconds: 60 },
  ];
  hub.patch = async (id, fields) => {
    await patch(id, fields);
    for (const model of models) {
      if (
        !hub.obs.some((c) =>
          usable(
            s,
            {
              ...c,
              catalog: allowed(models, {
                excluded_models: hub.rules[c.id],
                priority: c.priority ?? null,
              }),
            },
            model,
          ),
        )
      )
        violations.push(model);
    }
    // Models the ambiguous-response handler that swallowed the original hook expectations.
    throw Error("committed then 500");
  };
  let error: unknown;
  try {
    await execute(s, plan(s, hub.obs), hub, "unsafe", noop, noop, {
      target: "b",
      fields: { excluded_models: [models[1]], priority: null },
    });
  } catch (e) {
    error = e;
  }
  expect(violations).toEqual([]);
  expect(String(error)).toContain("last usable route");
});
