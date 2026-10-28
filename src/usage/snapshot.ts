import { createHash } from 'node:crypto';
import { redactDeep } from '../lib/redact';
import { assess } from '../steer/rank';
import type { Credential } from '../steer/types';

function credentials(input: unknown): Credential[] {
  if (!input || typeof input !== 'object' || !('files' in input) || !Array.isArray(input.files)) throw new Error('invalid credentials');
  return input.files.map((c: unknown) => {
    if (!c || typeof c !== 'object' || !('id' in c) || typeof c.id !== 'string' || !('provider' in c) || typeof c.provider !== 'string') throw new Error('invalid credential');
    // Validate the complete structure used by assess before trusting the API boundary.
    for (const key of ['account_type', 'status', 'next_retry_after'] as const) {
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

export function snapshot(input: unknown, now = Date.now()) {
  const rows = credentials(input).filter(c => c.provider?.toLowerCase() === 'claude' && c.account_type === 'oauth').map(c => ({ c, a: assess(c, now) }));
  const winner = rows.filter(r => r.a.healthy).sort((x, y) => (y.c.priority ?? 0) - (x.c.priority ?? 0) || later(x.a.reset7dMs, y.a.reset7dMs) || later(x.a.reset5hMs, y.a.reset5hMs) || x.c.id.localeCompare(y.c.id))[0];
  return {
    generated_at: new Date(now).toISOString(), source: 'cliproxy-hub', stale: false,
    accounts: rows.map(r => ({
      label: `claude-${createHash('sha256').update(r.c.id).digest('hex').slice(0, 8)}`,
      active: r === winner,
      five_hour: { used_pct: r.a.util5h === null ? null : r.a.util5h * 100, resets_at: iso(r.a.reset5hMs) },
      weekly: { used_pct: r.a.util7d === null ? null : r.a.util7d * 100, resets_at: iso(r.a.reset7dMs) },
      status: !r.a.healthy ? 'rejected' : r.a.util5h !== null || r.a.util7d !== null ? 'allowed' : 'unknown',
      priority: r.c.priority ?? 0, disabled: r.c.disabled === true || r.c.status === 'disabled',
    })),
  };
}
export function staleSnapshot(previous: ReturnType<typeof snapshot>) {
  return { ...previous, stale: true, last_error: 'hub unavailable' };
}
export function serialize(value: unknown): string {
  return JSON.stringify(redactDeep(value)) + '\n';
}
