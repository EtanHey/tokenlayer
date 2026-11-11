import { quotaKey, type Observation, type State, type RecoveryCheck } from "./core";

interface RecoveryHub {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  observations(): Promise<Observation[]>;
}
const cadence = 180000;
type Window = { utilization: number; reset: number };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function window(v: unknown): Window | null {
  if (!object(v) || typeof v.utilization !== "number" || !Number.isFinite(v.utilization) ||
      v.utilization < 0 || v.utilization > 100 || typeof v.resets_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v.resets_at)) return null;
  const reset = Date.parse(v.resets_at);
  const date = v.resets_at.slice(0, 10), day = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return null;
  return Number.isFinite(reset) ? { utilization: v.utilization / 100, reset: Math.floor(reset / 1000) * 1000 } : null;
}
function prior(c: Observation, now: number): Window | null {
  const q = c.quota, at = Date.parse(q?.observed_at ?? "");
  const sig = Object.fromEntries(Object.entries(q?.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const p = "anthropic-ratelimit-unified-7d-", raw = sig[p + "utilization"], reset = sig[p + "reset"];
  const numeric = (v: string | undefined) => typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN;
  const u = numeric(raw), r = Math.floor(numeric(reset)) * 1000;
  if (!Number.isFinite(at) || at > now || !Number.isFinite(u) || u < 0 || u > 1 ||
      !Number.isFinite(r) || r <= at || !["allowed", "allowed_warning", "rejected"].includes(sig[p + "status"])) return null;
  return { utilization: u, reset: r };
}
function quotaError(c: Observation) {
  const message = c.status_message ?? "";
  if (message === "quota exhausted" || message.startsWith("rate_limit_error:")) return true;
  try { return JSON.parse(message)?.error?.type === "rate_limit_error"; } catch { return false; }
}
function candidate(s: State, c: Observation, now: number) {
  const b = s.baseline[c.id];
  return !!c.auth_index && !!b && b.id === c.id && b.auth_index === c.auth_index &&
    b.name === c.name && b.email === c.email && (c.status === "active" || c.status === "error" && quotaError(c)) && !c.disabled &&
    Array.isArray(c.cooldowns) && c.cooldowns.length > 0 && c.cooldowns.every(x =>
      x.reason === "quota" && (x.scope === "credential" || x.scope === "model" && !!x.model_key) &&
      Date.parse(x.retry_at ?? "") - now >= 3600000);
}
const snapshot = (c: Observation) => JSON.stringify([
  c.id, c.name, c.email, c.auth_index, c.status, c.status_message, c.disabled, c.unavailable,
  c.cooldowns?.map(({ remaining_seconds, ...stable }) => stable), c.quota, c.model_quotas,
]);
const identity = (a: Observation, b: Observation) =>
  a.id === b.id && a.auth_index === b.auth_index && a.name === b.name && a.email === b.email;

/** Caller holds the controller lock. Metadata checks and recovery attempts are durable before I/O. */
export async function reconcile(s: State, hub: RecoveryHub, persist: () => void, clock = Date.now) {
  for (const c of await hub.observations()) {
    const now = clock();
    if (!candidate(s, c, now)) continue;
    s.recovery ??= {};
    const old = s.recovery[c.id];
    if (old?.index === c.auth_index && now - old.checkedAt < cadence) continue;
    const r: RecoveryCheck = { ...(old?.index === c.auth_index ? old : {}), index: c.auth_index!, checkedAt: now, result: "checked" };
    s.recovery[c.id] = r;
    persist();
    try {
      const response = await hub.request("POST", "/requests/api-call", {
        auth_index: c.auth_index, method: "GET", url: "https://api.anthropic.com/api/oauth/usage",
        header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
      });
      if (!object(response) || response.status_code !== 200 || typeof response.body !== "string") throw Error();
      const body: unknown = JSON.parse(response.body);
      if (!object(body)) throw Error();
      const week = window(body.seven_day), five = window(body.five_hour), before = prior(c, now);
      if (!week || week.reset <= clock() || clock() - now > 60000 || !before ||
          body.five_hour != null && (!five || five.reset <= clock() || five.utilization >= 1)) throw Error();
      const dropped = week.reset === before.reset && before.utilization >= 0.9 && before.utilization - week.utilization >= 0.5;
      const advanced = week.reset > before.reset && before.reset <= clock();
      const repeat = r.attempted && (week.reset < r.attempted.reset ||
        week.reset === r.attempted.reset && r.attempted.utilization - week.utilization < 0.5);
      if (week.utilization > 0.5 || !(dropped || advanced) || repeat) { r.result = "unchanged"; persist(); continue; }
      const refreshed = await hub.observations();
      const latest = refreshed.find(x => x.id === c.id);
      // This check is after the LAST await before the reset. No intervening network/persist await.
      if (!latest || refreshed.filter(x => x.auth_index === c.auth_index).length !== 1 ||
          snapshot(latest) !== snapshot(c) || !candidate(s, latest, clock())) {
        r.result = "stale"; persist(); continue;
      }
      r.attempted = { ...week, outcome: "attempted" };
      r.superseded = [...new Set([...(r.superseded ?? []), ...[c.quota, ...Object.values(c.model_quotas ?? {})].filter(Boolean).map(quotaKey)])].slice(-100);
      r.result = "attempted";
      persist();
      try { await hub.request("POST", "/routing/cooldown/reset", { auth_index: c.auth_index }); } catch { /* Readback resolves response loss. */ }
      r.result = "unconfirmed";
      try {
        const after = (await hub.observations()).find(x => x.id === c.id);
        if (after && identity(c, after) && after.status === "active" && !after.disabled && !after.unavailable &&
            Array.isArray(after.cooldowns) && after.cooldowns.length === 0) r.result = "cleared";
      } catch { /* No inference success is claimed. */ }
      r.attempted.outcome = r.result;
    } catch { r.result = "unknown"; }
    persist();
  }
}
