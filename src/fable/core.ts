import type { Credential } from "../steer/types";
export type Observation = Credential & {
  email?: string;
  catalog?: string[];
  model_quotas?: Record<string, NonNullable<Credential["quota"]>>;
};
export type Fields = {
  excluded_models: string[] | null;
  priority: number | null;
};
export type Baseline = Fields & {
  id: string;
  name: string;
  auth_index: string;
  email: string;
  provenance: string;
  schemaVersion: 2;
  models: string[];
};
export type Intent = {
  mode: "off" | "manual" | "auto";
  fableAccount: string;
  strictFableAccount: boolean;
  spillover: boolean | "auto";
  fableReserveOnA: boolean;
  reserveFraction: number;
  reserveMargin: number;
  allowNonFableOnFableAccount: boolean;
};
export type Applied =
  "OFF" | "APPLYING" | "ON" | "ON_WAIT_AT_CAP" | "DEGRADED" | "UNKNOWN";
export type Exception = "WAIT_AT_CAP" | "NO_UPSTREAM" | "RESERVE_CONFLICT";
export type Plan = {
  desired: Record<string, Fields>;
  applied: Applied;
  reason: string;
  exceptions: Record<string, Exception>;
  reserve?: {
    nonFableEstimate: number;
    confidence: "medium" | "conservative";
    triggered: boolean;
  };
};
export type State = Intent & {
  schemaVersion: 2;
  requested: Intent;
  applied: Applied;
  reason: string;
  baseline: Record<string, Baseline>;
  thresholds: { fableCapAt: number; weeklyExhaustedAt: number };
  ops: Record<string, string>;
  resets?: Record<string, { left: number | null; confirmedByEtan: boolean; confirmedZero?: boolean }>;
  policy?: Pick<Plan, "desired" | "exceptions" | "reserve">;
  pending?: { op: string; plan: Plan };
};
export function intent(s: Intent): Intent {
  const {
    mode,
    fableAccount,
    strictFableAccount,
    spillover,
    fableReserveOnA,
    reserveFraction,
    reserveMargin,
    allowNonFableOnFableAccount,
  } = s;
  return {
    mode,
    fableAccount,
    strictFableAccount,
    spillover,
    fableReserveOnA,
    reserveFraction,
    reserveMargin,
    allowNonFableOnFableAccount,
  };
}
export const defaults = (): State => {
  const requested: Intent = {
    mode: "off",
    fableAccount: "",
    strictFableAccount: false,
    spillover: "auto",
    fableReserveOnA: true,
    reserveFraction: 0.5,
    reserveMargin: 0.05,
    allowNonFableOnFableAccount: false,
  };
  return {
    ...requested,
    schemaVersion: 2,
    requested,
    applied: "UNKNOWN",
    reason: "not yet observed",
    baseline: {},
    thresholds: { fableCapAt: 0.99, weeklyExhaustedAt: 0.95 },
    ops: {},
  };
};
export const same = (a: string[], b: string[]) =>
  JSON.stringify([...new Set(a)].sort()) ===
  JSON.stringify([...new Set(b)].sort());
export const isFable = (m: string) => m.startsWith("claude-fable-");
export function matches(rule: string, model: string) {
  return new RegExp(
    "^" +
      rule
        .split("*")
        .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  ).test(model);
}
export const allowed = (models: string[], fields: Fields) =>
  models.filter(
    (m) => !(fields.excluded_models ?? []).some((r) => matches(r, m)),
  );
export function inventory(s: State, obs: Observation[]) {
  return (
    obs.length === 2 &&
    Object.keys(s.baseline).length === 2 &&
    same(
      Object.keys(s.baseline),
      obs.map((c) => c.id),
    ) &&
    obs.every((c) => {
      const b = s.baseline[c.id];
      return (
        b?.schemaVersion === 2 &&
        b.id === c.id &&
        b.name === c.name &&
        b.auth_index === c.auth_index &&
        b.email === c.email &&
        b.excluded_models === null &&
        b.priority === null &&
        b.models.length > 0
      );
    })
  );
}
export function quotaWindow(
  q: Observation["quota"],
  key: string,
  now: number,
  fresh = true,
) {
  const age = now - Date.parse(q?.observed_at ?? "");
  const sig = Object.fromEntries(
    Object.entries(q?.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const p = "anthropic-ratelimit-unified-" + key + "-";
  const u =
    sig[p + "utilization"] === undefined ? NaN : Number(sig[p + "utilization"]);
  const status = sig[p + "status"];
  if (
    !Number.isFinite(age) ||
    age < -60000 ||
    (fresh && age > 300000) ||
    !Number.isFinite(u) ||
    u < 0 ||
    !status
  )
    return null;
  return { u, rejected: status === "rejected" };
}
function fableQuota(c: Observation) {
  return Object.entries(c.model_quotas ?? {})
    .filter(([m]) => isFable(m))
    .map(([, q]) => q)
    .sort(
      (a, b) =>
        Date.parse(b.observed_at ?? "") - Date.parse(a.observed_at ?? ""),
    )[0];
}
function cooldown(c: Observation, model: string, now: number) {
  return (c.cooldowns ?? []).some(
    (x) =>
      (x.scope === "credential" ||
        (x.scope === "model" && x.model_key === model)) &&
      (Date.parse(x.retry_at ?? "") > now || (x.remaining_seconds ?? 0) > 0),
  );
}
/** Catalog membership is checked at each admission; baseline catalogs describe potential expanded routes only. */
export function usable(
  s: State,
  c: Observation,
  model: string,
  now = Date.now(),
) {
  const week = quotaWindow(c.quota, "7d", now);
  const fable = quotaWindow(fableQuota(c), "7d_oi", now);
  return (
    !!c.catalog?.includes(model) &&
    c.status === "active" &&
    !c.disabled &&
    !c.unavailable &&
    !cooldown(c, model, now) &&
    !!week &&
    !week.rejected &&
    week.u < s.thresholds.weeklyExhaustedAt &&
    (!isFable(model) ||
      (!!fable && !fable.rejected && fable.u < s.thresholds.fableCapAt))
  );
}
export function spillEnabled(s: State, account: string) {
  if (s.spillover !== "auto") return s.spillover;
  const reset = s.resets?.[account];
  return reset?.left === 0 && reset.confirmedByEtan ||
    reset?.left === null && reset.confirmedZero === true;
}
export function plan(s: State, obs: Observation[], now = Date.now()): Plan {
  if (s.mode === "auto") throw Error("auto not enabled yet");
  const desired = Object.fromEntries(
    Object.keys(s.baseline).map((id) => [
      id,
      { excluded_models: null, priority: null } as Fields,
    ]),
  );
  const p: Plan = { desired, applied: "OFF", reason: "off", exceptions: {} };
  if (!inventory(s, obs))
    return { ...p, applied: "UNKNOWN", reason: "credential inventory changed" };
  if (s.mode === "off") return p;
  const a = obs.find(
    (c) => c.email === s.fableAccount || c.id === s.fableAccount,
  );
  const b = obs.find((c) => c !== a);
  if (!a || !b)
    return { ...p, applied: "UNKNOWN", reason: "account not found" };
  const week = quotaWindow(a.quota, "7d", now),
    fable = quotaWindow(fableQuota(a), "7d_oi", now);
  const n = week ? Math.max(0, week.u - 0.5 * (fable?.u ?? 0)) : 0;
  const reserve =
    s.fableReserveOnA &&
    !s.allowNonFableOnFableAccount &&
    n >= s.reserveFraction - s.reserveMargin;
  p.reserve = {
    nonFableEstimate: n,
    confidence: fable ? "medium" : "conservative",
    triggered: reserve,
  };
  // Missing Fable quota gives conservative reserve arithmetic and no assumed Fable capacity.
  // Missing weekly observations cannot justify any policy restriction.
  if (
    obs.some((c) => {
      const w = quotaWindow(c.quota, "7d", now);
      const blocked =
        c.status !== "active" ||
        c.disabled ||
        c.unavailable ||
        (c.cooldowns ?? []).some(
          (x) =>
            x.scope === "credential" &&
            (Date.parse(x.retry_at ?? "") > now ||
              (x.remaining_seconds ?? 0) > 0),
        );
      // A stale-but-present observation is a transient loss of A, so B remains eligible (R1).
      const staleA = c === a && quotaWindow(c.quota, "7d", now, false);
      return !blocked && !w && !staleA;
    })
  )
    return {
      ...p,
      applied: "UNKNOWN",
      reason:
        "unreadable or stale signals; routing restored to normal (both accounts serve everything)",
    };
  desired[a.id].priority = 50;
  desired[b.id].priority = 100;
  p.applied = "ON";
  p.reason = "partition; non-Fable prefers B and spills to A";
  const potential = obs.map((c) => ({
    ...c,
    catalog: s.baseline[c.id].models,
  }));
  const can = (c: Observation, m: string) =>
    usable(
      s,
      potential.find((x) => x.id === c.id)!,
      m,
      now,
    );
  let transient = false;
  for (const model of [...new Set(potential.flatMap((c) => c.catalog))].filter(
    (m) => m.startsWith("claude-"),
  )) {
    const au = can(a, model),
      bu = can(b, model);
    if (isFable(model)) {
      const signals = Object.fromEntries(
        Object.entries(fableQuota(a)?.signals ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      const prefix = "anthropic-ratelimit-unified-7d_oi-";
      const cap =
        signals[prefix + "status"] === "rejected" ||
        Number(signals[prefix + "utilization"]) >= s.thresholds.fableCapAt;
      if (!au && !bu) {
        p.exceptions[model] = "NO_UPSTREAM";
        continue;
      }
      if (!spillEnabled(s, a.email ?? a.id) && (au || cap)) {
        (desired[b.id].excluded_models ??= []).push(model);
        if (!au) p.exceptions[model] = "WAIT_AT_CAP";
      }
      if (!au && !cap) {
        p.applied = "DEGRADED";
        transient = true;
      }
    } else if (!au && !bu) p.exceptions[model] = "NO_UPSTREAM";
    else if (reserve) {
      (desired[a.id].excluded_models ??= []).push(model);
      if (!bu) p.exceptions[model] = "RESERVE_CONFLICT";
    } else if (s.strictFableAccount && bu)
      (desired[a.id].excluded_models ??= []).push(model);
  }
  const fableOnB = s.baseline[b.id].models.filter(isFable);
  if (
    fableOnB.length &&
    fableOnB.every((m) => desired[b.id].excluded_models?.includes(m))
  )
    desired[b.id].excluded_models = ["claude-fable-*"];
  const exceptions = Object.values(p.exceptions);
  if (exceptions.some((x) => x !== "WAIT_AT_CAP")) p.applied = "DEGRADED";
  else if (exceptions.includes("WAIT_AT_CAP")) p.applied = "ON_WAIT_AT_CAP";
  if (exceptions.includes("RESERVE_CONFLICT"))
    p.reason = "non-Fable paused on Fable account to keep Fable room";
  else if (exceptions.length) p.reason = [...new Set(exceptions)].join(", ");
  else if (reserve) p.reason = "Fable reserve protected on A";
  if (transient) {
    const cause = a.disabled
      ? "disabled"
      : a.status !== "active"
        ? "credential failure"
        : a.unavailable
          ? "unavailable"
          : !week || !fable
            ? "stale or unreadable signals"
            : week.rejected || week.u >= s.thresholds.weeklyExhaustedAt
              ? "weekly exhausted"
              : "cooldown";
    p.reason = `transient Fable unavailability on A (${cause}); Fable routed via B; ${p.reason}`;
  }
  return p;
}
