import type { Credential } from "./types";

export interface Tiers {
  /** The single soonest-reset Max credential. */
  top: number;
  /** Every other Max credential, healthy or not (the selector skips unavailable ones itself). */
  normal: number;
  /** Claude API keys: Max API credits don't pay for Claude Code, so a key is never above the floor. */
  apiKey: number;
}

export const DEFAULT_TIERS: Tiers = { top: 100, normal: 50, apiKey: 0 };

export interface Assessment {
  kind: "max" | "api_key" | "other";
  healthy: boolean;
  /** Why the credential is not promotable (empty when healthy). */
  reason: string;
  /** Upcoming window resets in epoch ms; null when unknown or already passed. */
  reset5hMs: number | null;
  reset7dMs: number | null;
  util5h: number | null;
  util7d: number | null;
}

const PREFIX = "anthropic-ratelimit-unified-";

function signalsOf(c: Credential): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(c.quota?.signals ?? {})) out.set(k.toLowerCase(), String(v).trim());
  return out;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isFuture(ts: string | null | undefined, now: number): boolean {
  if (!ts) return false;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms > now;
}

interface Window {
  resetMs: number | null;
  util: number | null;
  /** The window says this credential is out of quota right now. */
  exhausted: boolean;
}

/** Read one unified window (`5h`, `7d`, or `""` for the representative one). A window whose reset has passed is stale. */
function window(s: Map<string, string>, name: string, now: number): Window {
  const p = name ? `${PREFIX}${name}-` : PREFIX;
  const resetSec = num(s.get(`${p}reset`));
  const resetMs = resetSec === null ? null : resetSec * 1000;
  const util = num(s.get(`${p}utilization`));
  if (resetMs !== null && resetMs <= now) return { resetMs: null, util: null, exhausted: false };
  const exhausted = s.get(`${p}status`)?.toLowerCase() === "rejected" || (util !== null && util >= 1);
  return { resetMs, util, exhausted };
}

export function assess(c: Credential, now: number): Assessment {
  const provider = (c.provider ?? c.type ?? "").trim().toLowerCase();
  const s = signalsOf(c);
  const h5 = window(s, "5h", now);
  const d7 = window(s, "7d", now);
  const base = { reset5hMs: h5.resetMs, reset7dMs: d7.resetMs, util5h: h5.util, util7d: d7.util };
  if (provider !== "claude") return { kind: "other", healthy: false, reason: "not claude", ...base };
  if ((c.account_type ?? "").trim().toLowerCase() !== "oauth") return { kind: "api_key", healthy: false, reason: "api key", ...base };

  const reason = blocker(c, now, d7, h5, window(s, "", now));
  return { kind: "max", healthy: reason === "", reason, ...base };
}

function blocker(c: Credential, now: number, d7: Window, h5: Window, unified: Window): string {
  const status = (c.status ?? "").trim().toLowerCase();
  if (c.disabled || status === "disabled") return "disabled";
  if (status === "error") return "error";
  if (c.unavailable) return "unavailable";
  if (isFuture(c.next_retry_after, now)) return "cooling down";
  if ((c.cooldowns ?? []).some((cd) => isFuture(cd.retry_at, now) || (!cd.retry_at && (cd.remaining_seconds ?? 0) > 0))) return "cooling down";
  if (d7.exhausted) return "7d exhausted";
  if (h5.exhausted) return "5h exhausted";
  if (unified.exhausted) return "rejected";
  return "";
}

const later = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);

/**
 * Target priority per Claude credential id (non-Claude credentials are absent, i.e. untouched).
 * The healthy Max credential whose week resets soonest (5h reset breaks ties) is alone at `top`;
 * one with no reset signal yet is never `top` (unknown is not soon) but stays at `normal`.
 */
export function rank(credentials: Credential[], now: number, opts: { tiers?: Tiers } = {}): Map<string, number> {
  const tiers = opts.tiers ?? DEFAULT_TIERS;
  const out = new Map<string, number>();
  const candidates: { id: string; a: Assessment }[] = [];
  for (const c of credentials) {
    const a = assess(c, now);
    if (a.kind === "other") continue;
    if (a.kind === "api_key") {
      out.set(c.id, tiers.apiKey);
      continue;
    }
    out.set(c.id, tiers.normal);
    if (a.healthy && (a.reset7dMs !== null || a.reset5hMs !== null)) candidates.push({ id: c.id, a });
  }
  candidates.sort((x, y) => later(x.a.reset7dMs, y.a.reset7dMs) || later(x.a.reset5hMs, y.a.reset5hMs) || x.id.localeCompare(y.id));
  if (candidates.length > 0) out.set(candidates[0].id, tiers.top);
  return out;
}
