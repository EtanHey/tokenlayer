import { expect, test } from 'bun:test';
import { enrich } from '../../src/usage/projection';
const now = Date.parse('2026-11-10T10:00:00Z');
const fixture = (time: number, pct: string) => ({files:[{id:'fixture', provider:'claude', account_type:'oauth', quota:{observed_at:new Date(time).toISOString(),signals:{'Anthropic-Ratelimit-Unified-7d-Utilization':pct,'Anthropic-Ratelimit-Unified-7d-Status':'allowed','Anthropic-Ratelimit-Unified-7d-Reset':'1800000000'}}, model_quotas:{'claude-fable-5-2':{observed_at:new Date(time).toISOString(),signals:{'Anthropic-Ratelimit-Unified-7d_oi-Utilization':pct}}}}]});
test('distinct observations support burn and projection; duplicate polls do not', () => {
 const first = enrich(fixture(now-1800000,'0.4'), [], now-1800000);
 const next = enrich(fixture(now,'0.44'), first.history, now);
 expect(next.accounts[0]!.weekly_pct).toBe(44);
 expect(next.accounts[0]!.burn_weekly_pct_per_hour).toBe(8);
 expect(next.accounts[0]!.burn_fable_pct_per_hour).toBe(8);
 expect(next.accounts[0]!.projected_weekly_empty_at).toBe(new Date(now+7*3600000).toISOString());
 expect(enrich(fixture(now,'0.44'), next.history, now+60000).history.length).toBe(4);
 expect(first.accounts[0]!.projected_weekly_empty_at).toBeNull();
});
test('reset boundary and decreasing utilization never project exhaustion', () => {
 const first = enrich(fixture(now-1800000,'0.8'), [], now-1800000);
 expect(enrich(fixture(now,'0.1'),first.history,now).accounts[0]!.projected_weekly_empty_at).toBeNull();
 expect(enrich(fixture(now,'0.1'),first.history,now+3*3600000).history).toHaveLength(0);
});

test('stale observations cannot become a fresh hour of samples', () => {
 const first = enrich(fixture(now-1800000,'0.4'), [], now-1800000);
 const repeated = enrich(fixture(now-1800000,'0.4'),first.history,now);
 expect(repeated.accounts[0]!.burn_weekly_pct_per_hour).toBeNull();
 expect(repeated.history).toHaveLength(2);
});

test('reset timestamps isolate quota cycles even when percentage rises', () => {
 const first = enrich(fixture(now-1800000,'0.4'), [], now-1800000);
 const changed = fixture(now,'0.44');
 changed.files[0]!.quota.signals['Anthropic-Ratelimit-Unified-7d-Reset']='1800600000';
 expect(enrich(changed,first.history,now).accounts[0]!.burn_weekly_pct_per_hour).toBeNull();
});

test('outages preserve only validated additive fields', async () => {
 const {staleSnapshot} = await import('../../src/usage/snapshot');
 const {history, ...value} = enrich(fixture(now,'0.44'),[],now);
 expect(staleSnapshot({...value, debug:'sentinel'})).toEqual({...value,stale:true,last_error:'hub unavailable'});
 expect(() => staleSnapshot({...value,accounts:[{...value.accounts[0],fable_pct:101}]})).toThrow();
});
