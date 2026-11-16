import { observe, type Runner } from "./probe";
import type { Target } from "./target";

export type Http = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number; body: string }>;
export const http: Http = async (url, headers, timeoutMs) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.text() };
};
export type GateDeps = { run: Runner; http: Http; sleep: (ms: number) => Promise<unknown>; now: () => number };
export type InFlight = { kind: "count"; n: number } | { kind: "absent" } | { kind: "unknown"; reason: string };
export type GateResult = {
  verdict: "idle" | "busy" | "busy_unknown"; signal: "in_flight" | "os_fallback"; reason: string;
  polls: number; nonZeroPolls: number; maxInFlight: number; waitedMs: number;
  fallback?: { runs: number; samples: number; lastVerdict: string; lastReason: string; commandError?: { step: string; kind: string }; parseStep?: string };
};
export type GateOptions = { confirmMs: number; pollMs: number; waitMs: number; fallbackWindowS?: number; fallbackSamples?: number };

/** GET the hub's in-flight count (CLIProxyAPI >= 8.0.70). 404 means the hub predates the route. */
export async function inFlight(h: Http, base: string, key: string | undefined): Promise<InFlight> {
  if (!key) return { kind: "unknown", reason: "mgmt_key_missing" };
  let r: { status: number; body: string };
  try { r = await h(`${base}/v8/management/observability/requests/in-flight`, { Authorization: `Bearer ${key}` }, 5_000); }
  catch (error) { return { kind: "unknown", reason: (error as Error)?.name === "TimeoutError" ? "timeout" : "unreachable" }; }
  if (r.status === 404) return { kind: "absent" };
  if (r.status !== 200) return { kind: "unknown", reason: `http_${r.status}` };
  try {
    const body = JSON.parse(r.body);
    if (Number.isSafeInteger(body?.in_flight) && body.in_flight >= 0 && body.by_provider && typeof body.by_provider === "object" && !Array.isArray(body.by_provider)) return { kind: "count", n: body.in_flight };
  } catch { /* falls through to malformed */ }
  return { kind: "unknown", reason: "malformed" };
}

/**
 * Idle when every poll across `confirmMs` reads in_flight == 0; a non-zero poll restarts the window.
 * Waits up to `waitMs` for such a window. Any unreadable answer is busy_unknown at once.
 * A 404 falls back to dense OS sampling (nettop/lsof), repeated while the wait budget lasts.
 */
export async function gate(d: GateDeps, t: Target, key: string | undefined, o: GateOptions): Promise<GateResult> {
  const start = d.now(); let streak: number | undefined, polls = 0, nonZeroPolls = 0, maxInFlight = 0;
  const done = (verdict: GateResult["verdict"], reason: string, extra: Partial<GateResult> = {}): GateResult =>
    ({ verdict, signal: "in_flight", reason, polls, nonZeroPolls, maxInFlight, waitedMs: d.now() - start, ...extra });
  for (;;) {
    const r = await inFlight(d.http, t.hubUrl, key); polls++;
    if (r.kind === "unknown") return done("busy_unknown", r.reason);
    if (r.kind === "absent") return fallback(d, t, o, start, polls);
    const now = d.now();
    if (r.n > 0) { streak = undefined; nonZeroPolls++; maxInFlight = Math.max(maxInFlight, r.n); }
    else { streak ??= now; if (now - streak >= o.confirmMs) return done("idle", "in_flight_zero_window"); }
    if (now - start + o.pollMs > o.waitMs) return done("busy", "in_flight_nonzero");
    await d.sleep(o.pollMs);
  }
}

async function fallback(d: GateDeps, t: Target, o: GateOptions, start: number, polls: number): Promise<GateResult> {
  const windowS = o.fallbackWindowS ?? t.fallbackWindowS, samples = o.fallbackSamples ?? t.fallbackSamples; let runs = 0;
  for (;;) {
    const r = await observe(d.run, d.sleep, windowS, samples, t.port, t.processName); runs++;
    const result = (verdict: GateResult["verdict"], reason: string): GateResult => ({ verdict, signal: "os_fallback", reason, polls, nonZeroPolls: 0, maxInFlight: 0, waitedMs: d.now() - start,
      fallback: { runs, samples: runs * samples, lastVerdict: r.verdict, lastReason: r.reason, ...(r.commandError ? { commandError: r.commandError } : {}), ...(r.parseStep ? { parseStep: r.parseStep } : {}) } });
    if (r.verdict === "busy_unknown") return result("busy_unknown", "os_signal_unreadable");
    if (r.verdict === "idle") return result("idle", "os_counters_unchanged");
    if (d.now() - start + windowS * 1000 > o.waitMs) return result("busy", "os_client_activity");
  }
}
