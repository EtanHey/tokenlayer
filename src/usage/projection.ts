import { snapshot } from './snapshot';
import { labelHash } from '../lib/hash';
const HOUR = 3600000;
export const projection = 'linear over last 60 min of hub quota observations';
type Sample = { label: string; window: 'weekly' | 'fable'; observed_at: string; pct: number; resets_at: string | null };
const round = (n: number) => Math.round(n * 10) / 10;
function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
export function parseHistory(body: string): Sample[] {
  return body.split('\n').flatMap(line => {
    try {
      const s = JSON.parse(line);
      if (!/^[a-f0-9]{16}$/.test(s.label) || !['weekly','fable'].includes(s.window)
        || !iso(s.observed_at) || typeof s.pct !== 'number' || !Number.isFinite(s.pct)
        || s.pct < 0 || s.pct > 100 || (s.resets_at !== null && !iso(s.resets_at))) return [];
      return [{ label:s.label, window:s.window, observed_at:iso(s.observed_at)!, pct:s.pct, resets_at:iso(s.resets_at) }];
    } catch { return []; }
  });
}
function reading(quota: any, name: string) {
  const signals = Object.fromEntries(Object.entries(quota?.signals ?? {}).map(([k,v]) => [k.toLowerCase(),v]));
  const prefix = `anthropic-ratelimit-unified-${name}-`;
  const raw = signals[prefix+'utilization'];
  const fraction = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const seconds = Number(signals[prefix+'reset']);
  const status = signals[prefix+'status'];
  return {
    pct: Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? round(fraction*100) : null,
    status: ['allowed','allowed_warning','rejected'].includes(String(status)) ? String(status) : null,
    resets_at: Number.isFinite(seconds) && seconds > 0 && seconds < 8640000000000
      ? new Date(seconds*1000).toISOString() : null,
    observed_at: iso(quota?.observed_at),
  };
}
export function enrich(input: unknown, previous: Sample[], now = Date.now()) {
  const base = snapshot(input, now);
  let history = previous.filter(s => Date.parse(s.observed_at) >= now-2*HOUR && Date.parse(s.observed_at) <= now);
  const files = (input as {files:any[]}).files;
  const accounts = base.accounts.map(account => {
    const c = files.find(c => labelHash(c.auth_index || c.id) === account.label);
    const weekly = reading(c.quota,'7d');
    const fable = reading(c.model_quotas?.['claude-fable-5-2'],'7d_oi');
    function estimate(window: 'weekly' | 'fable', value: ReturnType<typeof reading>) {
      if (value.pct !== null && value.observed_at && Date.parse(value.observed_at) <= now
        && Date.parse(value.observed_at) >= now-2*HOUR
        && !history.some(s => s.label === account.label && s.window === window && s.observed_at === value.observed_at)) {
        history.push({label:account.label, window, observed_at:value.observed_at, pct:value.pct, resets_at:value.resets_at});
      }
      const samples = history.filter(s => s.label === account.label && s.window === window
        && Date.parse(s.observed_at) >= now-HOUR).sort((a,b) => Date.parse(a.observed_at)-Date.parse(b.observed_at));
      // Start again after a reset or a utilization decrease; never span quota cycles.
      let start = 0;
      for (let i=1;i<samples.length;i++) {
        if (samples[i]!.resets_at !== samples[i-1]!.resets_at || samples[i]!.pct < samples[i-1]!.pct) start=i;
      }
      const first = samples[start], last = samples.at(-1);
      const span = first && last ? Date.parse(last.observed_at)-Date.parse(first.observed_at) : 0;
      const burn = span >= 15*60000 ? (last!.pct-first!.pct)/(span/HOUR) : null;
      const end = burn !== null && burn > 0 && value.pct !== null && value.observed_at === last?.observed_at
        ? Date.parse(last.observed_at)+(100-value.pct)/burn*HOUR : NaN;
      return {burn:burn === null ? null : round(burn), end:Number.isFinite(end) && end <= 8640000000000000
        ? new Date(end).toISOString() : null};
    }
    const w = estimate('weekly',weekly), f = estimate('fable',fable);
    return {...account, weekly_pct:weekly.pct, weekly_status:weekly.status, weekly_resets_at:weekly.resets_at,
      fable_pct:fable.pct, fable_status:fable.status, fable_resets_at:fable.resets_at,
      observed_at:weekly.observed_at, weekly_observed_at:weekly.observed_at, fable_observed_at:fable.observed_at,
      burn_weekly_pct_per_hour:w.burn, burn_fable_pct_per_hour:f.burn,
      projected_weekly_empty_at:w.end, projected_fable_cap_at:f.end};
  });
  return {...base, projection, accounts, history};
}
