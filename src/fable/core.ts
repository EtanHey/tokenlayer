import type { Credential } from "../steer/types";
export type Metadata = {
  form: "absent" | "null" | "list";
  list?: string[];
  disabled?: boolean;
};
export type Observation = Credential & {
  email?: string;
  model_quotas?: Record<string, NonNullable<Credential["quota"]>>;
};
export type State = {
  mode: "off" | "manual" | "auto";
  fableAccount: string;
  strictFableAccount: boolean;
  spillover: boolean;
  baseline: Record<string, Metadata>;
  thresholds: { fableCapAt: number; weeklyExhaustedAt: number };
  ops: Record<string, string>;
};
export const defaults = (): State => ({
  mode: "off",
  fableAccount: "",
  strictFableAccount: true,
  spillover: false,
  baseline: {},
  thresholds: { fableCapAt: 0.99, weeklyExhaustedAt: 0.95 },
  ops: {},
});
/** Only these two fields may leave the OAuth reader. Legacy aliases must be audited on upgrade. */
export function metadata(raw: Record<string, unknown>): Metadata {
  const x = raw.excluded_models;
  if (
    x !== undefined &&
    x !== null &&
    (!Array.isArray(x) || x.some((v) => typeof v !== "string"))
  )
    throw Error("invalid exclusion metadata");
  if (raw["excluded-models"] !== undefined)
    throw Error("legacy exclusions require audit");
  return {
    form: !Object.hasOwn(raw, "excluded_models")
      ? "absent"
      : x === null
        ? "null"
        : "list",
    ...(Array.isArray(x) ? { list: x as string[] } : {}),
    ...(typeof raw.disabled === "boolean" ? { disabled: raw.disabled } : {}),
  };
}
export const lists = (m: Metadata) => m.list ?? [];
export const same = (a: string[], b: string[]) =>
  JSON.stringify([...new Set(a)].sort()) ===
  JSON.stringify([...new Set(b)].sort());
export const equivalent = (a: Metadata, b: Metadata) =>
  same(lists(a), lists(b));
const strict = [
  "claude-opus-*",
  "claude-sonnet-*",
  "claude-haiku-*",
  "claude-3-*",
];
function window(q: Observation["quota"], key: string, now: number) {
  const age = now - Date.parse(q?.observed_at ?? "");
  const sig = Object.fromEntries(
    Object.entries(q?.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const p = "anthropic-ratelimit-unified-" + key + "-";
  const u = Number(sig[p + "utilization"]);
  const status = sig[p + "status"];
  if (
    !Number.isFinite(age) ||
    age < -60000 ||
    age > 300000 ||
    !Number.isFinite(u) ||
    u < 0 ||
    !status
  )
    return null;
  return { u, rejected: status === "rejected" };
}
export function plan(s: State, obs: Observation[], now = Date.now()) {
  if (s.mode === "auto") throw Error("auto not enabled yet");
  const desired = Object.fromEntries(
    Object.entries(s.baseline).map(([id, m]) => [id, [...lists(m)]]),
  );
  const base = (reason: string) => ({ desired, reason });
  if (s.mode === "off") return base("off");
  // This controller intentionally supports exactly two OAuth credentials.
  if (obs.length !== 2 || obs.some((c) => !s.baseline[c.id]))
    return base("credential inventory changed");
  const health = obs.map((c) => {
    const week = window(c.quota, "7d", now),
      fable = window(c.model_quotas?.["claude-fable-5-2"], "7d_oi", now);
    const blocked =
      c.disabled ||
      c.status !== "active" ||
      c.unavailable ||
      (c.cooldowns ?? []).some(
        (x) =>
          x.scope === "credential" &&
          (Date.parse(x.retry_at ?? "") > now ||
            (x.remaining_seconds ?? 0) > 0),
      );
    return {
      c,
      week,
      fable,
      usable:
        !blocked &&
        !!week &&
        !week.rejected &&
        week.u < s.thresholds.weeklyExhaustedAt,
      blocked,
    };
  });
  // A confirmed credential block needs no quota inference. Otherwise missing/stale data suspends policy.
  if (health.some((h) => !h.blocked && (!h.week || !h.fable)))
    return base("unreadable or stale signals");
  if (health.every((h) => !h.usable)) return base("both unusable");
  const a = health.find(
    (h) =>
      h.c.email === s.fableAccount ||
      h.c.id.includes("-" + s.fableAccount + ".json"),
  );
  const b = health.find((h) => h !== a);
  if (!a || !b) return base("account not found");
  if (s.strictFableAccount && b.usable && a.usable)
    desired[a.c.id].push(...strict);
  const fableCooling = (a.c.cooldowns ?? []).some(
    (x) =>
      x.scope === "model" &&
      x.model_key?.startsWith("claude-fable-") &&
      (Date.parse(x.retry_at ?? "") > now || (x.remaining_seconds ?? 0) > 0),
  );
  const capped =
    fableCooling ||
    !a.usable ||
    !a.fable ||
    a.fable.rejected ||
    a.fable.u >= s.thresholds.fableCapAt;
  if (!(capped && s.spillover)) desired[b.c.id].push("claude-fable-*");
  for (const id in desired) desired[id] = [...new Set(desired[id])];
  return base(capped ? "A capped or unusable" : "partition");
}
