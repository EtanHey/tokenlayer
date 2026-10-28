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
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('invalid timestamp');
  return Date.parse(value);
}
export function evaluate(input: unknown, options: Options) {
  const root = record(input);
  const age = options.now - timestamp(root.generated_at);
  if (root.stale !== false || age < 0 || age > 180000 || !Array.isArray(root.accounts)) throw Error('unhealthy snapshot');
  const accounts = root.accounts.map(record).filter(a => {
    if (typeof a.disabled !== 'boolean' || (a.enabled !== undefined && typeof a.enabled !== 'boolean')) throw Error('invalid serving flags');
    return !a.disabled && a.enabled !== false;
  }).map(a => {
    const five = record(a.five_hour), weekly = record(a.weekly);
    if (a.status !== 'allowed' || (five.status !== undefined && five.status !== 'allowed') || (weekly.status !== undefined && weekly.status !== 'allowed')) throw Error('unhealthy serving account');
    const used = percent(five.used_pct);
    if (percent(weekly.used_pct) >= 100) throw Error('weekly exhausted');
    const remaining = (timestamp(five.resets_at) - options.now) / 60000;
    if (remaining < 0 || remaining >= 300) throw Error('invalid reset window');
    const elapsed_min = 300 - remaining, score = used * 300 / elapsed_min;
    const warn = score > 80;
    const level: Level = used >= 80 ? 'brake80' : used >= 60 || (warn && options.kind !== 'lead') ? 'brake60' : 'green';
    return { level, pacing: { used, elapsed_min, score, warn } };
  });
  if (!accounts.length) return deny('no serving accounts');
  const rank = { green:0, brake60:1, brake80:2, 'no-headroom':3 };
  accounts.sort((a,b) => rank[b.level]-rank[a.level] || b.pacing.score-a.pacing.score);
  const worst = accounts[0];
  if (!worst) return deny('no serving accounts');
  const admit = predicate(worst.level, options);
  return { admit, reason: admit ? 'within fleet limits' : 'fleet brake or lead cap', level:worst.level, pacing:worst.pacing, accounts };
}
