import { redactText, REDACTED } from '../lib/redact';
export type Kind = 'lead' | 'claude.judgment' | 'claude.subagent.cheap' | 'claude.subagent.mechanical';
export type Level = 'green' | 'brake60' | 'brake80' | 'no-headroom';
export type Options = { kind: Kind; activeLeads: number; essential: boolean; now: number };
export function predicate(level: Level, options: Options): boolean {
  if (level === 'no-headroom') return false;
  if (options.kind !== 'lead') return level === 'green';
  return options.activeLeads < (level === 'brake80' ? 3 : level === 'brake60' ? 5 : 10)
    && (level !== 'brake80' || options.essential);
}
const emptyPacing = { used: null, elapsed_min: null, score: null, warn: false };
export function deny(reason: string) {
  return { admit: false, reason, level: 'no-headroom', pacing: emptyPacing, accounts: [] };
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
function windowReading(value: unknown, resetRequired: boolean) {
  const window = record(value);
  if (window.used_pct === null && window.resets_at === null) return null;
  const used = percent(window.used_pct);
  const reset = resetRequired || window.resets_at !== undefined ? timestamp(window.resets_at) : undefined;
  return { used, reset };
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
    const five = record(a.five_hour), weekly = record(a.weekly);
    if ([five.status, weekly.status].some(status => status === 'unknown' || status === 'rejected')) return null;
    if (a.status !== 'allowed' || (five.status !== undefined && five.status !== 'allowed') || (weekly.status !== undefined && weekly.status !== 'allowed')) throw Error('unhealthy serving account');
    const fiveReading = windowReading(five, true), weeklyReading = windowReading(weekly, false);
    if (!fiveReading || !weeklyReading) return null;
    const used = fiveReading.used;
    if (weeklyReading.used >= 100 || used >= 100) return null;
    const remaining = (fiveReading.reset! - options.now) / 60000;
    if (remaining < 0 || remaining >= 300) throw Error('invalid reset window');
    const elapsed_min = 300 - remaining, score = used * 300 / elapsed_min;
    const warn = score > 80;
    const level: Level = used >= 80 ? 'brake80' : used >= 60 || (warn && options.kind !== 'lead') ? 'brake60' : 'green';
    return { label: redactText(a.label.length === 15 && /^claude-[0-9a-f]{8}$/.test(a.label) ? a.label : REDACTED), level, pacing: { used, elapsed_min, score, warn } };
  }).filter(a => a !== null);
  if (!accounts.length) return deny('no accounts with headroom');
  const rank = { green:0, brake60:1, brake80:2, 'no-headroom':3 };
  accounts.sort((a,b) => rank[b.level]-rank[a.level] || b.pacing.score-a.pacing.score);
  const worst = accounts[0];
  if (!worst) return deny('no accounts with headroom');
  const admit = predicate(worst.level, options);
  return { admit, reason: admit ? 'within fleet limits' : 'fleet brake or lead cap', level:worst.level, pacing:worst.pacing, accounts };
}
