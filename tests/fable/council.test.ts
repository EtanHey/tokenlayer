import { expect, test } from "bun:test";
import { plan, allowed, usable, type State } from "../../src/fable/core";
import { execute } from "../../src/fable/io";
import { models, state, observed, fakeHub } from "./fixtures";
const now = Date.now();
const exclusions = (p: ReturnType<typeof plan>, id: string) =>
  p.desired[id].excluded_models ?? [];
const run = (
  s: State,
  p: ReturnType<typeof plan>,
  hub: ReturnType<typeof fakeHub>,
  op: string,
  persist = () => {},
) => execute(s, p, hub, op, persist, () => {});
const blocked = (rules: string[], model: string) =>
  rules.some((r) =>
    new RegExp("^" + r.replaceAll("*", ".*") + "$").test(model),
  );
const cooling = (id: string, model: string) => ({
  ...observed(id),
  cooldowns: [
    {
      scope: "model",
      model_key: model,
      retry_at: new Date(now + 60000).toISOString(),
    },
  ],
});
test("MUST-1 A: non-cap Fable cooldown routes through B even without spillover", () => {
  const p = plan(state(), [cooling("a", models[0]), observed("b")], now);
  expect(p.applied).toBe("DEGRADED");
  expect(allowed(models, p.desired.b)).toContain(models[0]);
  expect(p.reason).toContain("transient");
});
test("MUST-1 B: strict lifts only Opus after B's Opus cooldown", () => {
  const p = plan(
    { ...state(), strictFableAccount: true },
    [observed("a"), cooling("b", models[1])],
    now,
  );
  expect(blocked(exclusions(p, "a"), models[1])).toBe(false);
  expect(blocked(exclusions(p, "a"), models[2])).toBe(true);
});
test("MUST-2: reserve protects healthy A at N=.55 when B fails", () => {
  const p = plan(
    state(),
    [observed("a", 0.8, 0.5), { ...observed("b"), status: "error" }],
    now,
  );
  expect(blocked(exclusions(p, "a"), models[1])).toBe(true);
  expect(p.applied).toBe("DEGRADED");
  expect(p.exceptions[models[1]]).toBe("RESERVE_CONFLICT");
  expect(usable(state(), observed("a", 0.8, 0.5), models[0])).toBe(true);
  expect(allowed(models, p.desired.a)).toContain(models[0]);
});
// Remaining executor cases share this real in-process hub state, including exact catalogs.
test("MUST-3: OFF from strict clears both exclusions and both priorities", async () => {
  const s = state(),
    hub = fakeHub();
  hub.rules.a = [models[1], models[2]];
  hub.rules.b = [models[0]];
  hub.obs[0].priority = 50;
  hub.obs[1].priority = 100;
  s.mode = "off";
  const p = plan(s, hub.obs, now);
  await run(s, p, hub, "off");
  expect(hub.rules).toEqual({ a: [], b: [] });
  expect(hub.obs.map((c) => c.priority ?? null)).toEqual([null, null]);
});
test("MUST-4: crash after B100 cannot save ON; restart resumes", async () => {
  const s = state(),
    hub = fakeHub();
  let killed = false;
  let durable = structuredClone(s);
  const persist = () => {
    if (!killed && hub.obs[1].priority === 100) {
      killed = true;
      throw Error("killed");
    }
    if (!killed) durable = structuredClone(s);
  };
  await expect(
    run(s, plan(s, hub.obs, now), hub, "crash", persist),
  ).rejects.toThrow("killed");
  expect(s.applied).not.toBe("ON");
  expect(durable.applied).toBe("APPLYING");
  const restarted = structuredClone(durable);
  await run(restarted, plan(restarted, hub.obs, now), hub, "crash");
  expect(restarted.applied).toBe("ON");
  expect(hub.rules.b).toEqual(["claude-fable-*"]);
});
test("SHOULD-1: replacement under same email refuses every write", async () => {
  const s = state(),
    hub = fakeHub();
  hub.obs[1].auth_index = "replacement";
  await expect(run(s, plan(s, hub.obs, now), hub, "replace")).rejects.toThrow(
    "inventory",
  );
  expect(hub.calls).toEqual([]);
});
test("SHOULD-2: 200 empty catalog is an error, never confirmation", async () => {
  const s = state(),
    hub = fakeHub();
  hub.catalog = async () => [];
  await expect(run(s, plan(s, hub.obs, now), hub, "empty")).rejects.toThrow(
    "catalog",
  );
  expect(s.applied).not.toBe("ON");
});
