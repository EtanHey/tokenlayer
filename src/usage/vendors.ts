// Codex and Cursor limits, read from the provider caches T3 Code refreshes about once a minute
// (~/.t3/caches/<instance>.json). Only numbers and timestamps are copied; auth stays behind.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VENDOR_STALE_MS = 10 * 60_000;
const DRIVERS = ['codex', 'cursor'] as const;
type Win = { id: string; window: string | null; pct: number; resets_at: string | null };
export type VendorReading = { pct: number | null; window: string | null; resets_at: string | null; observed_at: string | null;
  source: string; stale: boolean; windows: Win[]; last_error?: string };

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const span = (mins: unknown, kind: unknown) => typeof mins === 'number' && Number.isInteger(mins) && mins > 0
  ? mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`
  : typeof kind === 'string' && /^[a-z]{1,16}$/.test(kind) ? kind : null;
const empty = (source: string, last_error: string, observed_at: string | null = null): VendorReading =>
  ({ pct: null, window: null, resets_at: null, observed_at, source, stale: true, windows: [], last_error });

export function vendorReading(cache: unknown, now: number): VendorReading {
  const c = obj(cache), limits = obj(c.usageLimits);
  const source = typeof c.instanceId === 'string' && /^[a-z0-9-]{1,40}$/.test(c.instanceId) ? `t3-cache:${c.instanceId}` : 't3-cache';
  const observed_at = iso(limits.checkedAt);
  const windows: Win[] = [];
  for (const raw of Array.isArray(limits.windows) ? limits.windows : []) {
    const w = obj(raw);
    if (typeof w.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(w.id) || typeof w.usedPercent !== 'number'
      || !(w.usedPercent >= 0 && w.usedPercent <= 100)) continue;
    windows.push({ id: w.id, window: span(w.windowDurationMins, w.kind), pct: w.usedPercent, resets_at: iso(w.resetsAt) });
  }
  // The binding window is the fullest; on a tie, the one that frees up last.
  const bind = [...windows].sort((a, b) => b.pct - a.pct || Date.parse(b.resets_at ?? '') - Date.parse(a.resets_at ?? '') || 0)[0];
  if (!bind) return empty(source, 'usage unavailable', observed_at);
  const stale = observed_at === null || now - Date.parse(observed_at) > VENDOR_STALE_MS
    || (bind.resets_at !== null && Date.parse(bind.resets_at) <= now);
  return { pct: bind.pct, window: bind.window, resets_at: bind.resets_at, observed_at, source, stale, windows };
}

// Prefer the default instance (codex.json, cursor.json); otherwise the freshest other instance of that driver.
export async function readVendors(dir: string, now = Date.now()) {
  const found: Record<string, { file: string; r: VendorReading }[]> = {};
  let names: string[] = [];
  try { names = (await readdir(dir)).filter(n => n.endsWith('.json')); } catch {}
  for (const file of names) {
    try {
      const cache = obj(JSON.parse(await readFile(join(dir, file), 'utf8')));
      if (!DRIVERS.includes(cache.driver as never) || cache.enabled === false) continue;
      (found[cache.driver as string] ??= []).push({ file, r: vendorReading(cache, now) });
    } catch {}
  }
  const pick = (d: string) => (found[d] ?? []).sort((a, b) => Number(b.file === `${d}.json` && b.r.pct !== null) - Number(a.file === `${d}.json` && a.r.pct !== null)
    || Number(b.r.pct !== null) - Number(a.r.pct !== null) || Date.parse(b.r.observed_at ?? '') - Date.parse(a.r.observed_at ?? '') || 0)[0]?.r
    ?? empty('t3-cache', 'no T3 usage cache');
  return { codex: pick('codex'), cursor: pick('cursor') };
}
