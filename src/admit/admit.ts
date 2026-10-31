import { redactText, REDACTED } from '../lib/redact';
import { CLAUDE_POLICY } from './policy';
export type Kind = 'lead' | 'claude.judgment' | 'claude.subagent.cheap' | 'claude.subagent.mechanical';
export type Level = 'green' | 'slow' | 'stop' | 'no-headroom';
export type Options = { kind: Kind; activeLeads: number; essential: boolean; now: number };
export function predicate(level: Level, options: Options): boolean {
  if (level === 'no-headroom') return false;
  if (options.kind !== 'lead') return level === 'green';
  return options.activeLeads < CLAUDE_POLICY.leads[level]
    && (level !== 'stop' || options.essential);
}
type Pacing = Partial<Record<'five_hour' | 'weekly', { used: number; elapsed_min: number | null; projected: number | null }>>;
export function deny(reason: string) {
  return { admit: false, reason, level: 'no-headroom', pacing: {} as Pacing, accounts: [] };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid telemetry');
  return Object.fromEntries(Object.entries(value));
}
function percent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw Error('invalid utilization');
  return value;
}
export function timestamp(value: unknown): number {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value) throw Error('invalid timestamp');
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction ?? '').padEnd(3,'0')}Z`;
  const wall = Date.parse(local);
  // Date.parse normalizes impossible calendar dates; require an exact round trip.
  if (!Number.isFinite(wall) || new Date(wall).toISOString() !== local) throw Error('invalid timestamp');
  const offsetHours = zone === 'Z' ? 0 : Number(zone!.slice(1,3));
  const offsetMinutes = zone === 'Z' ? 0 : Number(zone!.slice(4,6));
  if (offsetHours > 23 || offsetMinutes > 59) throw Error('invalid timezone');
  const offset = (offsetHours * 60 + offsetMinutes) * 60000 * (zone![0] === '-' ? -1 : 1);
  const parsed = Date.parse(value as string);
  if (!Number.isFinite(parsed) || parsed !== wall - offset) throw Error('invalid timestamp');
  return parsed;
}
function windowReading(value: unknown) {
  const window = record(value);
  if (window.absent !== undefined) {
    if (window.absent !== true || window.used_pct !== null || window.resets_at !== null || window.rolled_over !== undefined) throw Error('invalid absent window');
    return { absent: true } as const;
  }
  if (window.rolled_over === true) {
    if (window.used_pct !== 0 || window.resets_at !== null) throw Error('invalid rollover');
    return { used: 0, reset: undefined, rolledOver: true };
  }
  const used = window.used_pct === null ? null : percent(window.used_pct);
  const reset = window.resets_at == null ? undefined : timestamp(window.resets_at);
  if (used === null) return null;
  return { used, reset, rolledOver: false };
}
export function evaluate(input: unknown, options: Options) {
  const root = record(input);
  const age = options.now - timestamp(root.generated_at);
  if (root.stale !== false || age < 0 || age > 180000 || !Array.isArray(root.accounts)) throw Error('unhealthy snapshot');
  const accounts = root.accounts.map(record).filter(a => {
    if (typeof a.disabled !== 'boolean' || (a.enabled !== undefined && typeof a.enabled !== 'boolean')) throw Error('invalid serving flags');
    return !a.disabled && a.enabled !== false;
  }).map(a => {
    if (typeof a.label !== 'string') throw Error('invalid account label');
    if (a.status === 'unknown' || a.status === 'rejected') return null;
    if (a.five_hour === null || a.weekly === null) return null;
    const five = record(a.five_hour), weekly = record(a.weekly);
    if ([five.status, weekly.status].some(status => status === 'unknown' || status === 'rejected')) return null;
    if (a.status !== 'allowed' || (five.status !== undefined && five.status !== 'allowed') || (weekly.status !== undefined && weekly.status !== 'allowed')) throw Error('unhealthy serving account');
    const fiveReading = windowReading(five), weeklyReading = windowReading(weekly);
    if (!fiveReading || !weeklyReading) return null;
    const pacing: Pacing = {};
    let level: Level = 'green';
    for (const [name, reading, minutes] of [['five_hour', fiveReading, 300], ['weekly', weeklyReading, 10080]] as const) {
      if ('absent' in reading) continue;
      const { used, reset, rolledOver } = reading;
      if (used >= 100) return null;
      const remaining = reset === undefined ? null : (reset - options.now) / 60000;
      if (remaining !== null && (remaining < 0 || remaining >= minutes)) throw Error('invalid reset window');
      const elapsed_min = remaining === null ? null : minutes - remaining;
      const projected = rolledOver ? 0 : elapsed_min === null ? null : used * minutes / elapsed_min;
      pacing[name] = { used, elapsed_min, projected };
      const brake = CLAUDE_POLICY.brake;
      if (used >= brake.stopUsedPct) level = 'stop';
      else if (level === 'green' && elapsed_min !== null && elapsed_min >= minutes * brake.minElapsedPct / 100 && projected! > brake.projectionPct) level = 'slow';
    }
    if (!Object.keys(pacing).length) return null;
    return { label: redactText(a.label.length === 16 && /^[0-9a-f]{16}$/.test(a.label) ? a.label : REDACTED), level, pacing };
  }).filter(a => a !== null);
  if (!accounts.length) return deny('no accounts with headroom');
  const rank = { green:0, slow:1, stop:2, 'no-headroom':3 };
  accounts.sort((a,b) => rank[a.level]-rank[b.level]);
  const best = accounts[0];
  if (!best) return deny('no accounts with headroom');
  const admit = predicate(best.level, options);
  return { admit, reason: admit ? 'within fleet limits' : 'fleet brake or lead cap', level:best.level, pacing:best.pacing, accounts };
}
