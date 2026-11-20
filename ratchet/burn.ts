// claude_burn_2h: is the fleet using the Claude week at the rate it can afford?
// Whatever is left of a weekly quota at its reset is lost, so a long idle stretch is the failure to catch
// (2026-11-19: about 8 h at 3 points, unnoticed); burning far faster than the week allows is the other one.
// The target is read fresh on every run (orc, 2026-11-20): (week % left − reserve %) / hours until the in-use
// account's weekly reset. The row fails when the last 2 h ran under half of it, or the last hour over twice it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { israelClock } from '../src/dashboard/israel-time';

export const BURN_WINDOW_S = 2 * 3600;
/** The over-run side looks at the last hour only: a burst, not the 2 h average. */
export const BURST_WINDOW_S = 3600;
/** An account idle longer than this has no baseline; its next reading starts its own sequence. */
export const BURN_LOOKBACK_S = 8 * 86400;
export const WEEK_S = 7 * 86400;
/** The weekly quota only. `%7d%utilization%` would also match `7d_oi`, the separate Fable quota. */
export const WEEK_UTILIZATION = 'anthropic-ratelimit-unified-7d-utilization';
export const WEEK_RESET = 'anthropic-ratelimit-unified-7d-reset';
export const BURN_TARGET_PATH = join(homedir(), '.config/tokenlayer/burn-target.json');
export const DEFAULT_RESERVE_PCT = 8;

/** One account's reading: the last one before the window (`base` 1) or the max of one 15-minute bucket in it. */
export type Point = { account: string; base: 0 | 1; bucket: number; u: number; reset: number; at: number };
/** The week % orc keeps back. `from` is "file", or why the default is in use (said on every line). */
export type Reserve = { pct: number; from: string };
/** `fail` decides the row (two-sided); `threshold` is the under-run floor, for the log; null = no target. */
export type Verdict = { value: number; threshold: number | null; fail: boolean; say: string };

/**
 * Per account: the last weekly utilization (a fraction) before the window, then the max per quota cycle and 15-minute bucket inside
 * it. Max, not last: requests in one bucket can land out of order. Buckets count back from `nowS`, so the last hour
 * starts on a bucket edge. A reset inside a bucket keeps both cycles in reset order. The table is a ReplacingMergeTree; a duplicate row never changes a max, so no FINAL.
 * `at` is the last reading's second, rounded up, so a reading after a window edge never sorts before it.
 */
export const burnSQL = (nowS: number, windowS = BURN_WINDOW_S, lookbackS = BURN_LOOKBACK_S) => `SELECT account_hash AS account, base, bucket,
    if(base = 1, argMax(util, ts), max(util)) AS u, argMax(wreset, ts) AS reset, toUInt64(ceil(toUnixTimestamp64Milli(max(ts)) / 1000)) AS at
  FROM (
    SELECT account_hash, ts, toFloat64OrNull(ratelimit['${WEEK_UTILIZATION}']) AS util,
      toUInt64OrZero(ratelimit['${WEEK_RESET}']) AS wreset,
      toUInt8(ts <= toDateTime(${nowS - windowS}, 'UTC')) AS base,
      if(base = 1, 0, wreset) AS cycle,
      if(base = 1, 0, ${nowS} - 900 * (intDiv(${nowS * 1000} - toUnixTimestamp64Milli(ts), 900000) + 1)) AS bucket
    FROM tokenlayer.proxy_usage
    WHERE ts > toDateTime(${nowS - windowS - lookbackS}, 'UTC') AND ts <= toDateTime(${nowS}, 'UTC')
      AND mapContains(ratelimit, '${WEEK_UTILIZATION}') AND util IS NOT NULL)
  GROUP BY account, base, bucket, cycle ORDER BY account, base DESC, bucket, reset
  FORMAT JSONEachRow`;

export const parsePoints = (jsonEachRow: string): Point[] => jsonEachRow.split('\n').filter(Boolean).map(line => {
  const r = JSON.parse(line);
  return { account: String(r.account), base: Number(r.base) ? 1 : 0, bucket: Number(r.bucket), u: Number(r.u), reset: Number(r.reset), at: Number(r.at) };
});

/**
 * Week used since `windowStartS`, as a fraction, summed over accounts: each account's rises between consecutive
 * readings, from its last reading at or before the window start. A fall is ignored. A new weekly cycle (the reset
 * moved on) counts the new week's use only when that week began inside the window; otherwise how much of it fell
 * inside is unknown, and it counts 0 (the alarm side).
 */
export function burnRise(points: Point[], windowStartS: number): number {
  let rise = 0;
  const byAccount = new Map<string, Point[]>();
  for (const p of points) byAccount.set(p.account, [...(byAccount.get(p.account) ?? []), p]);
  for (const all of byAccount.values()) {
    all.sort((a, b) => b.base - a.base || a.bucket - b.bucket || a.reset - b.reset);
    let from = 0;
    all.forEach((p, i) => { if (p.base === 1 || p.at <= windowStartS) from = i; });
    const pts = all.slice(from);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1]!, p = pts[i]!;
      const newCycle = p.reset > prev.reset + 3600;
      rise += newCycle ? (prev.reset >= windowStartS ? p.u : 0) : Math.max(0, p.u - prev.u);
    }
  }
  return Math.round(rise * 1e4) / 1e4;
}

/**
 * orc's reserve, from `reserve_pct` in burn-target.json (other keys, like the old `pct_per_hour`, are not read).
 * No file or no key: the default, and `from` says so. A value orc cannot have meant (bad JSON, not 0–100): throws,
 * so the row shows FAIL with value MISSING instead of passing silently.
 */
export function readReserve(path = process.env.TOKENLAYER_BURN_TARGET || BURN_TARGET_PATH): Reserve {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { pct: DEFAULT_RESERVE_PCT, from: 'default, no burn-target.json' };
    throw e;
  }
  const r = (JSON.parse(text) as { reserve_pct?: unknown }).reserve_pct;
  if (r === undefined) return { pct: DEFAULT_RESERVE_PCT, from: 'default, no reserve_pct in burn-target.json' };
  if (!(typeof r === 'number' && r >= 0 && r < 100)) throw Error('burn-target.json: reserve_pct must be a number from 0 to under 100');
  return { pct: r, from: 'file' };
}

const fmt = (n: number, places = 1) => String(Number(n.toFixed(places)));
const at2 = (n: number) => Math.round(n * 100) / 100;
const clock = (s: number) => israelClock(new Date(s * 1000));
const perHour = (rise: number, windowS: number) => at2(rise * 100 / (windowS / 3600));

export function burnVerdict(points: Point[], reserve: Reserve, nowS: number): Verdict {
  const value = perHour(burnRise(points, nowS - BURN_WINDOW_S), BURN_WINDOW_S);
  const burst = perHour(burnRise(points, nowS - BURST_WINDOW_S), BURST_WINDOW_S);
  const kept = `${fmt(reserve.pct)}% reserve${reserve.from === 'file' ? '' : ` (${reserve.from})`}`;
  // The in-use account: the latest reading. Its week, and its reset, set the target.
  const last = points.reduce<Point | undefined>((a, p) => (!a || p.at > a.at ? p : a), undefined);
  if (!last) {
    return { value, threshold: null, fail: true, say: `no Claude weekly reading in ${BURN_LOOKBACK_S / 86400} days, so no target: Claude ran ${fmt(value)}%/h for the last ${BURN_WINDOW_S / 3600} h; ${kept}` };
  }
  // A reset that has passed with no reading since: a new week, all of it left, until the next weekly reset.
  const passed = last.reset <= nowS;
  const reset = passed ? last.reset + Math.ceil((nowS - last.reset + 1) / WEEK_S) * WEEK_S : last.reset;
  const leftPct = passed ? 100 : (1 - last.u) * 100;
  const hours = (reset - nowS) / 3600;
  const raw = (leftPct - reserve.pct) / hours;
  // Judged on the target as shown (4 places), so float noise in "45% left" never flips an exact edge.
  const target = Math.round(Math.max(0, raw) * 1e4) / 1e4;
  const under = value < target / 2, over = burst > target * 2;
  const threshold = at2(target / 2);
  const why = under ? 'under half the target: ' : over ? 'over twice the target: ' : '';
  const left = passed ? '100% of the new week left' : `${fmt(leftPct)}% of the week left`;
  const say = `${why}Claude ran ${fmt(value, 2)}%/h for the last ${BURN_WINDOW_S / 3600} h and ${fmt(burst, 2)}%/h for the last hour`
    + ` against a ${fmt(target, 2)}%/h target (alarm under ${fmt(target / 2, 2)}%/h for 2 h or over ${fmt(target * 2, 2)}%/h for 1 h);`
    + ` target = (${left} − ${kept}) / ${fmt(hours)} h until the reset ${clock(reset)}`
    + (raw < 0 ? ', 0 at or under the reserve' : '')
    + (passed ? ` (the last reading's week reset at ${clock(last.reset)}, no reading since)` : '');
  return { value, threshold, fail: under || over, say };
}
