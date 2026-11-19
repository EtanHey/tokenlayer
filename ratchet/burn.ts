// claude_burn_2h: is the fleet using the Claude week at the rate orc asked for?
// Whatever is left of a weekly quota at its reset is lost, so a long idle stretch is the failure to catch
// (2026-11-19: about 8 h at 3 points, unnoticed). Orc writes the target rate to burn-target.json; the row fails when
// the last 2 h rose by less than half of it. No target file, or a target past its `until`: report only.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BURN_WINDOW_S = 2 * 3600;
/** An account idle longer than this has no baseline; its next reading starts its own sequence. */
export const BURN_LOOKBACK_S = 8 * 86400;
/** The weekly quota only. `%7d%utilization%` would also match `7d_oi`, a separate per-model quota. */
export const WEEK_UTILIZATION = 'anthropic-ratelimit-unified-7d-utilization';
export const WEEK_RESET = 'anthropic-ratelimit-unified-7d-reset';
export const BURN_TARGET_PATH = join(homedir(), '.config/tokenlayer/burn-target.json');
const ZONE = 'Asia/Jerusalem';

/** One account's reading: the last one before the window (`base` 1) or the max of one 15-minute bucket in it. */
export type Point = { account: string; base: 0 | 1; bucket: number; u: number; reset: number; at: number };
export type Target = { pct_per_hour: number; set_by?: string; until?: string };
export type Verdict = { value: number; threshold: number | null; say: string };

/**
 * Per account: the last weekly utilization (a fraction) before the window, then the max per 15-minute bucket inside
 * it. Max, not last: requests in one bucket can land out of order. The table is a ReplacingMergeTree; a duplicate row
 * never changes a max, so no FINAL.
 */
export const burnSQL = (nowS: number, windowS = BURN_WINDOW_S, lookbackS = BURN_LOOKBACK_S) => `SELECT account_hash AS account, base, bucket,
    if(base = 1, argMax(util, ts), max(util)) AS u, argMax(wreset, ts) AS reset, toUnixTimestamp(max(ts)) AS at
  FROM (
    SELECT account_hash, ts, toFloat64OrNull(ratelimit['${WEEK_UTILIZATION}']) AS util,
      toUInt64OrZero(ratelimit['${WEEK_RESET}']) AS wreset,
      toUInt8(ts <= toDateTime(${nowS - windowS}, 'UTC')) AS base,
      if(base = 1, 0, toUnixTimestamp(toStartOfFifteenMinutes(ts))) AS bucket
    FROM tokenlayer.proxy_usage
    WHERE ts > toDateTime(${nowS - windowS - lookbackS}, 'UTC') AND ts <= toDateTime(${nowS}, 'UTC')
      AND mapContains(ratelimit, '${WEEK_UTILIZATION}') AND util IS NOT NULL)
  GROUP BY account, base, bucket ORDER BY account, base DESC, bucket
  FORMAT JSONEachRow`;

export const parsePoints = (jsonEachRow: string): Point[] => jsonEachRow.split('\n').filter(Boolean).map(line => {
  const r = JSON.parse(line);
  return { account: String(r.account), base: Number(r.base) ? 1 : 0, bucket: Number(r.bucket), u: Number(r.u), reset: Number(r.reset), at: Number(r.at) };
});

/**
 * Week used in the window, as a fraction, summed over accounts: each account's rises between consecutive readings.
 * A fall is ignored. A new weekly cycle (the reset moved on) counts the new week's use only when that week began
 * inside the window; otherwise how much of it fell inside is unknown, and it counts 0 (the alarm side).
 */
export function burnRise(points: Point[], windowStartS: number): number {
  let rise = 0;
  const byAccount = new Map<string, Point[]>();
  for (const p of points) byAccount.set(p.account, [...(byAccount.get(p.account) ?? []), p]);
  for (const pts of byAccount.values()) {
    pts.sort((a, b) => b.base - a.base || a.bucket - b.bucket);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1]!, p = pts[i]!;
      const newCycle = p.reset > prev.reset + 3600;
      rise += newCycle ? (prev.reset >= windowStartS ? p.u : 0) : Math.max(0, p.u - prev.u);
    }
  }
  return Math.round(rise * 1e4) / 1e4;
}

/** The orc target. Missing file: null. A file orc cannot have meant (bad JSON, no positive rate, bad until): throws. */
export function readTarget(path = process.env.TOKENLAYER_BURN_TARGET || BURN_TARGET_PATH): Target | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const t = JSON.parse(text) as Target;
  if (!(typeof t.pct_per_hour === 'number' && t.pct_per_hour > 0)) throw Error('burn-target.json: pct_per_hour must be a positive number');
  if (t.until !== undefined && !Number.isFinite(Date.parse(t.until))) throw Error('burn-target.json: until must be an ISO time');
  return t;
}

const when = (s: number) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(s * 1000)).replace(',', '');
const pct = (n: number) => String(Number(n.toFixed(1)));

/** What is left of the in-use account's week (the account with the latest reading), in words. */
function weekLeft(points: Point[], nowS: number): string {
  const last = points.reduce<Point | undefined>((a, p) => (!a || p.at > a.at ? p : a), undefined);
  if (!last) return `no Claude request in ${BURN_LOOKBACK_S / 86400} days`;
  if (last.reset <= nowS) return `the in-use account's week reset at ${when(last.reset)} with no request since`;
  return `${pct((1 - last.u) * 100)}% of the week is left until ${when(last.reset)}`;
}

export function burnVerdict(points: Point[], target: Target | null, nowS: number, windowS = BURN_WINDOW_S): Verdict {
  const value = Math.round(burnRise(points, nowS - windowS) * 100 / (windowS / 3600) * 100) / 100;
  const ran = `Claude ran ${pct(value)}%/h for the last ${windowS / 3600} h`;
  const left = weekLeft(points, nowS);
  if (!target) return { value, threshold: null, say: `${ran}; no burn target set, report only; ${left}` };
  if (target.until && Date.parse(target.until) <= nowS * 1000) {
    return { value, threshold: null, say: `${ran}; the ${pct(target.pct_per_hour)}%/h burn target expired at ${target.until}, report only; ${left}` };
  }
  const threshold = target.pct_per_hour / 2;
  return { value, threshold, say: `${ran} against a ${pct(target.pct_per_hour)}%/h target (alarm under ${pct(threshold)}%/h); ${left}` };
}
