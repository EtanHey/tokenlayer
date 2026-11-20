// Codex, Cursor and Antigravity limits, read from the provider caches T3 Code refreshes about once a minute
// (~/.t3/caches/<instance>.json). Only numbers and timestamps are copied; auth stays behind.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { iso } from './projection';
import type { Use } from './use';

export const VENDOR_STALE_MS = 600_000;
const DRIVERS = ['codex', 'cursor', 'antigravity', 'kiro'];
type Win = { id: string; window: string | null; pct: number; resets_at: string | null };
export type VendorReading = { pct: number | null; window: string | null; resets_at: string | null; observed_at: string | null;
  source: string; stale: boolean; windows: Win[]; last_error?: string; note?: string; use?: Use };

const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' ? v : {};
const at = (v: string | null) => Date.parse(v ?? '') || 0;
const span = (m: any, kind: unknown) => Number.isInteger(m) && m > 0 ? m % 1440 ? m % 60 ? `${m}m` : `${m / 60}h` : `${m / 1440}d`
  : typeof kind === 'string' && /^[a-z]{1,16}$/.test(kind) ? kind : null;
const empty = (source: string, last_error: string, observed_at: string | null): VendorReading =>
  ({ pct: null, window: null, resets_at: null, observed_at, source, stale: true, windows: [], last_error });

export function vendorReading(cache: unknown, now: number): VendorReading {
  const c = obj(cache), limits = obj(c.usageLimits), observed_at = iso(limits.checkedAt);
  const source = /^[a-z0-9-]{1,40}$/.test(c.instanceId ?? '') ? `t3-cache:${c.instanceId}` : 't3-cache';
  const windows: Win[] = (Array.isArray(limits.windows) ? limits.windows : []).flatMap((raw: unknown) => {
    const w = obj(raw), pct = w.usedPercent;
    return typeof w.id === 'string' && /^[\w-]{1,40}$/.test(w.id) && typeof pct === 'number' && pct >= 0 && pct <= 100
      ? [{ id: w.id, window: span(w.windowDurationMins, w.kind), pct, resets_at: iso(w.resetsAt) }] : [];
  });
  // The binding window is the fullest; on a tie, the one that frees up last.
  const bind = [...windows].sort((a, b) => b.pct - a.pct || at(b.resets_at) - at(a.resets_at))[0];
  // Kiro's cache carries no usage at all; name what it does carry (key names only, never values).
  if (!bind) return { ...empty(source, 'usage unavailable', observed_at),
    note: c.usageLimits ? undefined : `no usageLimits, only ${Object.keys(c).sort()}` };
  const stale = !observed_at || at(observed_at) - now > 60_000 || now - at(observed_at) > VENDOR_STALE_MS || (at(bind.resets_at) || Infinity) <= now;
  return { pct: bind.pct, window: bind.window, resets_at: bind.resets_at, observed_at, source, stale, windows };
}

// Per driver: a reading with numbers first, then the default instance (codex.json), then the freshest.
export async function readVendors(dir: string, now = Date.now()) {
  const found: { driver: unknown; rank: number; r: VendorReading }[] = [];
  for (const file of (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.json'))) {
    try {
      const c = obj(JSON.parse(await readFile(join(dir, file), 'utf8'))), r = vendorReading(c, now);
      if (c.enabled !== false) found.push({ driver: c.driver, rank: 2 * +(r.pct !== null) + +(file === `${c.driver}.json`), r });
    } catch {}
  }
  const pick = (d: string) => found.filter(x => x.driver === d)
    .sort((a, b) => b.rank - a.rank || at(b.r.observed_at) - at(a.r.observed_at))[0]?.r ?? empty('t3-cache', 'no T3 usage cache', null);
  return Object.fromEntries(DRIVERS.map(d => [d, pick(d)])) as Record<string, VendorReading>;
}
