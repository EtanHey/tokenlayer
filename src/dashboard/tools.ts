// The "All tools" panel: one row per tool, each with % of its window used, the reset, 24 h / 7 d use
// and a STALE / UNKNOWN mark.
// - Codex, Cursor, Antigravity, Kiro: `vendors` in the M4's ~/.config/tokenlayer/usage.json (written there every
//   60 s, src/usage). The M1 cannot read that file, so the dashboard reads it over ssh with short timeouts
//   (the ratchet's usage_json_age_s pattern) and caches it; an asleep M4 leaves the last reading, marked STALE.
//   Their `use` blocks were counted by the M4's writer from the M1 store (session_events, 7 days).
// - Claude, per account: the hub's own quota readback and the M1's proxy_usage (hub traffic only).
import type { Observation } from "../fable/core";
import { labelHash } from "../lib/hash";
import { unreachable, USAGE_HOST, type Probe } from "../../ratchet/usage-age";
import { VENDOR_STALE_MS } from "../usage/vendors";
export type { Probe };

/** A Claude hub reading older than this is STALE (the dashboard's account cards use the same 5 min). */
export const CLAUDE_STALE_MS = 300_000;
export const M4_TTL_MS = 60_000;
const USAGE = "~/.config/tokenlayer/usage.json";
/** Reads only the usage file; prints a marker instead when it is absent, so "missing" is not "ssh failed". */
export const M4_USAGE_REMOTE = `if [ -f ${USAGE} ]; then cat ${USAGE}; else echo __MISSING__; fi`;
const VENDORS = [["codex", "Codex"], ["cursor", "Cursor"], ["antigravity", "Antigravity"], ["kiro", "Kiro"]] as const;

export type M4Snapshot = {
  /** fresh: read this time; asleep: ssh says the Mac is not there; missing: no file; error: ssh or JSON broke. */
  state: "fresh" | "asleep" | "missing" | "error";
  /** The last good file, kept across asleep/error so its numbers can show as STALE. */
  usage: { generated_at?: string | null; vendors?: Record<string, any> } | null;
  /** When `usage` was read (ms). */
  fetched_at: number | null;
  error?: string;
};

/** Async ssh with the ratchet probe's options; killed after `timeoutMs` so a stuck host cannot hold a request. */
export async function sshM4Async(remote: string, host = process.env.TOKENLAYER_USAGE_HOST || USAGE_HOST,
  timeoutMs = 8_000): Promise<Probe> {
  const p = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2", host, remote], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode: p.signalCode ? null : exitCode, stdout, stderr: p.signalCode ? "Operation timed out (dashboard)" : stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** A cached reader of the M4's usage.json: at most one ssh per `ttlMs`, one in flight at a time. */
export function m4Usage(probe: (remote: string) => Promise<Probe> = (r) => sshM4Async(r),
  o: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = o.ttlMs ?? M4_TTL_MS, now = o.now ?? Date.now;
  let snap: M4Snapshot = { state: "error", usage: null, fetched_at: null, error: "not read yet" };
  let tried = -Infinity, inflight: Promise<M4Snapshot> | null = null;
  async function refresh(): Promise<M4Snapshot> {
    const at = now();
    let p: Probe;
    try { p = await probe(M4_USAGE_REMOTE); } catch { p = { exitCode: null, stdout: "", stderr: "" }; }
    const keep = { usage: snap.usage, fetched_at: snap.fetched_at };
    if (unreachable(p) || p.exitCode === null) return { state: "asleep", ...keep };
    if (p.exitCode !== 0) return { state: "error", ...keep, error: "ssh failed (exit " + p.exitCode + ")" };
    if (p.stdout.trim() === "__MISSING__") return { state: "missing", usage: null, fetched_at: null };
    try {
      const usage = JSON.parse(p.stdout);
      if (!usage || typeof usage !== "object") throw 0;
      return { state: "fresh", usage: { generated_at: usage.generated_at ?? null, vendors: usage.vendors ?? {} }, fetched_at: at };
    } catch {
      return { state: "error", ...keep, error: "usage.json unreadable" };
    }
  }
  return async function read(): Promise<M4Snapshot> {
    if (inflight) return inflight;
    if (now() - tried < ttl) return snap;
    tried = now();
    inflight = refresh().then((s) => (snap = s)).finally(() => (inflight = null));
    return inflight;
  };
}

/** Claude hub traffic per credential, 24 h and 7 d, bounded to 7 days. */
export const claudeUseSQL = `SELECT credential, countIf(ts >= now() - INTERVAL 1 DAY) AS r1, count() AS r7,
 sumIf(total_tokens, ts >= now() - INTERVAL 1 DAY) AS t1, sum(total_tokens) AS t7
 FROM tokenlayer.proxy_usage FINAL
 WHERE ts >= now() - INTERVAL 7 DAY AND provider = 'claude'
 GROUP BY credential
 SETTINGS max_execution_time=10, do_not_merge_across_partitions_select_final=1`;

export type UseLine = { sessions: number | null; requests: number | null; tokens: number | null; credits: number | null };
export type ToolRow = {
  name: string;
  tool: string;
  pct: number | null;
  window: string | null;
  resets_at: string | null;
  observed_at: string | null;
  use: { "24h": UseLine | null; "7d": UseLine | null } | null;
  mark: "OK" | "STALE" | "UNKNOWN";
  why: string | null;
  note?: string;
};

export function age(ms: number) {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min < 120 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`;
}
const ts = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
function signal(q: Observation["quota"], key: string) {
  const want = key.toLowerCase();
  return Object.entries(q?.signals ?? {}).find(([k]) => k.toLowerCase() === want)?.[1];
}
function resetIso(v: unknown) {
  if (v === null || v === undefined) return null;
  const text = String(v);
  const ms = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function useLine(w: any): UseLine | null {
  if (!w || typeof w !== "object") return null;
  const i = num(w.input_tokens), o = num(w.output_tokens);
  return { sessions: num(w.sessions), requests: num(w.requests),
    tokens: i === null && o === null ? null : (i ?? 0) + (o ?? 0), credits: num(w.credits) };
}

export function toolRows(i: {
  m4: M4Snapshot;
  /** null: the hub readback failed. */
  claude: Observation[] | null;
  claudeUse: { credential: string; r1: unknown; r7: unknown; t1: unknown; t7: unknown }[] | null;
  now?: number;
}): ToolRow[] {
  const now = i.now ?? Date.now();
  const rows: ToolRow[] = i.claude === null ? [{ name: "Claude", tool: "claude", pct: null, window: null, resets_at: null,
    observed_at: null, use: null, mark: "UNKNOWN", why: "hub readback unavailable" }] : i.claude.map((c) => {
    const pct = num(signal(c.quota, "anthropic-ratelimit-unified-7d-utilization"));
    const observed_at = c.quota?.observed_at ?? null, old = now - ts(observed_at);
    const fable = num(signal(c.model_quotas?.["claude-fable-5-2"], "anthropic-ratelimit-unified-7d_oi-utilization"));
    const u = i.claudeUse && (i.claudeUse.find((r) => r.credential === labelHash(c.auth_index)) ??
      { r1: 0, r7: 0, t1: 0, t7: 0 });
    const line = (r: unknown, t: unknown): UseLine => ({ sessions: null, requests: num(r) ?? 0, tokens: num(t) ?? 0, credits: null });
    return {
      name: "Claude · " + (c.email ?? c.id),
      tool: "claude",
      pct: pct === null ? null : pct * 100,
      window: pct === null ? null : "7d",
      resets_at: resetIso(signal(c.quota, "anthropic-ratelimit-unified-7d-reset")),
      observed_at,
      use: u ? { "24h": line(u.r1, u.t1), "7d": line(u.r7, u.t7) } : null,
      mark: pct === null ? "UNKNOWN" : !(old <= CLAUDE_STALE_MS) ? "STALE" : "OK",
      why: pct === null ? "no quota reading from the hub"
        : !(old <= CLAUDE_STALE_MS) ? (Number.isFinite(old) ? `hub reading ${age(old)} old` : "hub reading time unknown") : null,
      note: fable === null ? undefined : `Fable ${Math.round(fable * 100)}% of its allowance`,
    };
  });
  const { m4 } = i;
  const generated = ts(m4.usage?.generated_at);
  // Why the whole file is not current, if it is not. Asleep/error keep the old numbers; missing has none.
  const fileWhy = !m4.usage
    ? m4.state === "missing" ? "M4 usage.json missing"
      : m4.state === "asleep" ? "M4 asleep, no reading yet"
      : `M4 ${m4.error ?? "unreadable"}, no reading yet`
    : m4.state === "asleep" ? `M4 asleep; reading ${age(now - (Number.isFinite(generated) ? generated : m4.fetched_at!))} old`
    : m4.state === "error" ? `M4 ${m4.error}; reading ${age(now - (Number.isFinite(generated) ? generated : m4.fetched_at!))} old`
    : !(now - generated <= VENDOR_STALE_MS) ? (Number.isFinite(generated) ? `usage.json ${age(now - generated)} old` : "usage.json time unknown")
    : null;
  for (const [key, name] of VENDORS) {
    const v = m4.usage?.vendors?.[key];
    if (!m4.usage || !v || typeof v !== "object") {
      rows.push({ name, tool: key, pct: null, window: null, resets_at: null, observed_at: null, use: null, mark: "UNKNOWN",
        why: m4.usage ? "not in usage.json" + (fileWhy ? "; " + fileWhy : "") : fileWhy });
      continue;
    }
    const pct = num(v.pct), observed_at = typeof v.observed_at === "string" ? v.observed_at : null;
    const old = now - ts(observed_at);
    // An old file already explains an old reading; say it once.
    const own = pct === null ? (v.last_error ? String(v.last_error) : "no reading")
      : fileWhy ? null
      : v.stale === true || !(old <= VENDOR_STALE_MS)
        ? (Number.isFinite(old) ? `reading ${age(old)} old` : "reading time unknown") : null;
    const why = [own, fileWhy].filter(Boolean).join("; ") || null;
    rows.push({
      name, tool: key, pct, window: pct === null ? null : (v.window ?? null),
      resets_at: pct === null ? null : resetIso(v.resets_at), observed_at,
      use: v.use && (v.use["24h"] || v.use["7d"]) ? { "24h": useLine(v.use["24h"]), "7d": useLine(v.use["7d"]) } : null,
      mark: pct === null ? "UNKNOWN" : why ? "STALE" : "OK",
      why,
    });
  }
  return rows;
}
