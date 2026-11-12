import { quotaKey, type Observation, type State, type RecoveryCheck } from "./core";

interface RecoveryHub {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  observations(): Promise<Observation[]>;
}
function urgent(c: Observation, obs: Observation[], now: number) {
  const peers = obs.filter(x => x.id !== c.id);
  // Unknown route metadata cannot justify slowing recovery.
  if (peers.some(x => !Array.isArray(x.cooldowns) || !Array.isArray(x.catalog) ||
      typeof x.status !== "string" || typeof x.disabled !== "boolean" || typeof x.unavailable !== "boolean" ||
      x.cooldowns.some(d => !d || !["credential", "model"].includes(d.scope ?? "") ||
        d.scope === "model" && !d.model_key || !Number.isFinite(Date.parse(d.retry_at ?? ""))))) return true;
  const models = c.cooldowns!.some(d => d.scope === "credential")
    ? [...new Set([...c.catalog ?? [], ...peers.flatMap(x => [...x.catalog!, ...x.cooldowns!.flatMap(d => d.model_key ? [d.model_key] : [])])])]
    : c.cooldowns!.map(d => d.model_key!);
  return !models.length || models.some(model => !peers.some(x =>
    x.provider === "claude" && x.account_type === "oauth" && x.status === "active" && !x.disabled && !x.unavailable &&
    !x.cooldowns!.some(d => (d.scope === "credential" || d.model_key === model) &&
      (Date.parse(d.retry_at!) > now || (d.remaining_seconds ?? 0) > 0))));
}
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
type Meter = Window & { kind: string };
function limits(v: unknown, now: number): Meter[] | null {
  if (!Array.isArray(v)) return null;
  const meters: Meter[] = [];
  for (const entry of v) {
    if (!object(entry) || typeof entry.kind !== "string") return null;
    const parsed = window({ utilization: entry.percent, resets_at: entry.resets_at });
    if (!parsed || parsed.reset <= now) return null;
    meters.push({ ...parsed, kind: entry.kind });
  }
  return meters;
}
function recovered(c: Observation, meters: Meter[], superseded: string[]) {
  if (meters.some(m => m.utilization >= 0.95)) return false;
  return c.cooldowns!.every(cooldown => {
    const q = cooldown.scope === "model" ? c.model_quotas?.[cooldown.model_key!] : c.quota;
    if (!q || superseded.includes(quotaKey(q))) return false;
    const sig = Object.fromEntries(Object.entries(q.signals ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const exhausted = ["7d", "7d_oi"].filter(m => {
      const p = `anthropic-ratelimit-unified-${m}-`, u = sig[p + "utilization"];
      return sig[p + "status"] === "rejected" || typeof u === "string" &&
        /^\d+(?:\.\d+)?$/.test(u) && Number.isFinite(Number(u)) && Number(u) >= 0.99;
    });
    return exhausted.length > 0 && exhausted.every(m => {
      const current = meters.filter(x => x.kind === (m === "7d" ? "weekly_all" : "weekly_scoped"));
      return current.length > 0 && current.every(x => x.utilization <= 0.5);
    });
  });
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
  const observations = await hub.observations();
  for (const c of observations) {
    const now = clock();
    if (!candidate(s, c, now)) continue;
    s.recovery ??= {};
    const old = s.recovery[c.id];
    const isUrgent = urgent(c, observations, now);
    if (old?.index === c.auth_index && now - old.checkedAt < (isUrgent ? 180000 : 1800000)) continue;
    const r: RecoveryCheck = { ...(old?.index === c.auth_index ? old : {}), index: c.auth_index!, checkedAt: now, urgent: isUrgent, result: "checked" };
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
      if (!week || week.reset <= clock() || clock() - now > 60000 ||
          body.five_hour != null && (!five || five.reset <= clock() || five.utilization >= 1)) throw Error();
      const meters = limits(body.limits, clock());
      if (body.limits != null && !meters) throw Error();
      const directCount = r.directAttempts?.reset === week.reset ? r.directAttempts.count : 0;
      let eligible: boolean;
      if (meters) eligible = directCount < 3 && recovered(c, meters, r.superseded ?? []);
      else {
        if (!before) throw Error();
        const dropped = week.reset === before.reset && before.utilization >= 0.9 && before.utilization - week.utilization >= 0.5;
        const advanced = week.reset > before.reset && before.reset <= clock();
        const repeat = r.attempted && (week.reset < r.attempted.reset ||
          week.reset === r.attempted.reset && r.attempted.utilization - week.utilization < 0.5);
        eligible = week.utilization <= 0.5 && !!(dropped || advanced) && !repeat;
      }
      if (!eligible) { r.result = "unchanged"; persist(); continue; }
      const refreshed = await hub.observations();
      const latest = refreshed.find(x => x.id === c.id);
      // This check is after the LAST await before the reset. No intervening network/persist await.
      if (!latest || refreshed.filter(x => x.auth_index === c.auth_index).length !== 1 ||
          snapshot(latest) !== snapshot(c) || !candidate(s, latest, clock())) {
        r.result = "stale"; persist(); continue;
      }
      r.attempted = { ...week, outcome: "attempted" };
      if (meters) r.directAttempts = { reset: week.reset, count: directCount + 1 };
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
