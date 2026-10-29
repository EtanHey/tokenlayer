import { labelHash } from '../lib/hash';
import { redactDeep } from '../lib/redact';
import { assess } from '../steer/rank';
import type { Credential } from '../steer/types';

function credentials(input: unknown): Credential[] {
  if (!input || typeof input !== 'object' || !('files' in input) || !Array.isArray(input.files)) throw new Error('invalid credentials');
  return input.files.map((c: unknown) => {
    if (!c || typeof c !== 'object' || !('id' in c) || typeof c.id !== 'string' || !('provider' in c) || typeof c.provider !== 'string') throw new Error('invalid credential');
    // Validate the complete structure used by assess before trusting the API boundary.
    for (const key of ['account_type', 'status', 'next_retry_after', 'auth_index'] as const) {
      if (key in c && (c as Record<string, unknown>)[key] !== null && typeof (c as Record<string, unknown>)[key] !== 'string') throw new Error('invalid credential');
    }
    for (const key of ['disabled', 'unavailable'] as const) if (key in c && typeof (c as Record<string, unknown>)[key] !== 'boolean') throw new Error('invalid credential');
    if ('priority' in c && c.priority !== null && (typeof c.priority !== 'number' || !Number.isFinite(c.priority))) throw new Error('invalid priority');
    if ('cooldowns' in c && c.cooldowns !== null && (!Array.isArray(c.cooldowns) || c.cooldowns.some(cd => !cd || typeof cd !== 'object' || (cd.retry_at !== undefined && typeof cd.retry_at !== 'string') || (cd.remaining_seconds !== undefined && typeof cd.remaining_seconds !== 'number')))) throw new Error('invalid cooldowns');
    if ('quota' in c && c.quota !== null) {
      if (typeof c.quota !== 'object') throw new Error('invalid quota');
      if ('signals' in c.quota && (typeof c.quota.signals !== 'object' || c.quota.signals === null || Object.values(c.quota.signals).some(v => typeof v !== 'string'))) throw new Error('invalid signals');
    }
    return c as Credential;
  });
}
const later = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();

function signals(c: Credential) {
  return Object.fromEntries(Object.entries(c.quota?.signals ?? {}).map(([k,v]) => [k.toLowerCase(),v.trim().toLowerCase()]));
}
function reading(c: Credential, name: string, used: number | null, reset: number | null, now: number, rejected: boolean) {
  const raw = signals(c)[`anthropic-ratelimit-unified-${name}-reset`];
  const previous = raw ? Number(raw) * 1000 : NaN;
  if (!rejected && Number.isFinite(previous) && previous <= now)
    return { used_pct: 0, resets_at: null, rolled_over: true };
  return { used_pct: used === null ? null : used * 100, resets_at: iso(reset) };
}

export function snapshot(input: unknown, now = Date.now()) {
  const rows = credentials(input).filter(c => c.provider?.toLowerCase() === 'claude' && c.account_type === 'oauth').map(c => {
    const a = assess(c, now);
    const rejected = !a.healthy || c.status === 'rejected' || ['', '5h-', '7d-'].some(w => signals(c)[`anthropic-ratelimit-unified-${w}status`] === 'rejected');
    return { c, a, rejected };
  });
  const winner = rows.filter(r => !r.rejected).sort((x, y) => (y.c.priority ?? 0) - (x.c.priority ?? 0) || later(x.a.reset7dMs, y.a.reset7dMs) || later(x.a.reset5hMs, y.a.reset5hMs) || x.c.id.localeCompare(y.c.id))[0];
  return {
    generated_at: new Date(now).toISOString(), source: 'cliproxy-hub', stale: false,
    accounts: rows.map(r => {
      const five = reading(r.c, '5h', r.a.util5h, r.a.reset5hMs, now, r.rejected);
      const weekly = reading(r.c, '7d', r.a.util7d, r.a.reset7dMs, now, r.rejected);
      return {
        label: labelHash(r.c.auth_index || r.c.id),
        active: r === winner,
        five_hour: five, weekly,
        status: r.rejected ? 'rejected' : [five, weekly].some(w => w.used_pct !== null) ? 'allowed' : 'unknown',
        priority: r.c.priority ?? 0, disabled: r.c.disabled === true || r.c.status === 'disabled',
      };
    }),
  };
}
// Previous files are untrusted input too: validate values and rebuild every level.
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid previous snapshot');
  return value as Record<string, unknown>;
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('invalid snapshot date');
  return value;
}
function window(value: unknown) {
  const v = record(value);
  if (v.used_pct !== null && (typeof v.used_pct !== 'number' || !Number.isFinite(v.used_pct) || v.used_pct < 0 || v.used_pct > 100)) throw new Error('invalid snapshot percentage');
  if (v.rolled_over !== undefined && (v.rolled_over !== true || v.used_pct !== 0 || v.resets_at !== null)) throw new Error('invalid rollover');
  return { used_pct: v.used_pct, resets_at: date(v.resets_at), ...(v.rolled_over === true ? {rolled_over:true} : {}) };
}
export function staleSnapshot(input: unknown) {
  const previous = record(input);
  if (previous.source !== 'cliproxy-hub' || typeof previous.stale !== 'boolean' || !Array.isArray(previous.accounts)
    || ('last_error' in previous && previous.last_error !== 'hub unavailable')) throw new Error('invalid previous snapshot');
  const generated_at = date(previous.generated_at);
  if (generated_at === null && (!previous.stale || previous.accounts.length !== 0)) throw new Error('invalid empty snapshot');
  const accounts = previous.accounts.map(value => {
    const a = record(value);
    if (typeof a.label !== 'string' || !/^[a-f0-9]{16}$/.test(a.label)
      || typeof a.active !== 'boolean' || typeof a.disabled !== 'boolean'
      || typeof a.priority !== 'number' || !Number.isFinite(a.priority)
      || !['allowed', 'rejected', 'unknown'].includes(a.status as string)) throw new Error('invalid snapshot account');
    return { label: a.label, active: a.active, five_hour: window(a.five_hour), weekly: window(a.weekly), status: a.status, priority: a.priority, disabled: a.disabled };
  });
  return { generated_at, source: 'cliproxy-hub', stale: true, accounts, last_error: 'hub unavailable' };
}
export function serialize(value: unknown): string {
  return JSON.stringify(redactDeep(value)) + '\n';
}
