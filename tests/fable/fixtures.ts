import {
  defaults,
  type State,
  type Observation,
  type Fields,
} from "../../src/fable/core";
const now = Date.now();
export const models = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
];
export function observed(id: string, week = 0.2, fable = 0.2): Observation {
  const q = {
    observed_at: new Date(now).toISOString(),
    signals: {
      "Anthropic-Ratelimit-Unified-7d-Utilization": String(week),
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Utilization": String(fable),
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "allowed",
    },
  };
  return {
    id,
    name: id,
    auth_index: id,
    email: id,
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    quota: q,
    model_quotas: { "claude-fable-5-2": q },
    catalog: [...models],
  } as Observation;
}
export function state(): State {
  return {
    ...defaults(),
    mode: "manual",
    fableAccount: "a",
    baseline: Object.fromEntries(
      ["a", "b"].map((id) => [
        id,
        {
          id,
          name: id,
          email: id,
          auth_index: id,
          schemaVersion: 2,
          provenance: "test",
          excluded_models: null,
          priority: null,
          models: [...models],
        },
      ]),
    ),
  } as State;
}
const blocked = (rules: string[], model: string) =>
  rules.some((r) =>
    new RegExp("^" + r.replaceAll("*", ".*") + "$").test(model),
  );
export function fakeHub() {
  const obs = [observed("a"), observed("b")];
  const rules: Record<string, string[]> = { a: [], b: [] };
  const calls: { id: string; fields: Partial<Fields> }[] = [];
  return {
    obs,
    rules,
    calls,
    observations: async () => structuredClone(obs),
    catalog: async (id: string) => models.filter((m) => !blocked(rules[id], m)),
    patch: async (id: string, fields: Partial<Fields>) => {
      calls.push({ id, fields });
      if ("excluded_models" in fields) rules[id] = fields.excluded_models ?? [];
      if ("priority" in fields)
        obs.find((c) => c.id === id)!.priority = fields.priority;
    },
  };
}
