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
 expect(staleSnapshot({...value, debug:'sentinel'}, now)).toEqual({...value,stale:true,last_error:'hub unavailable'});
 expect(() => staleSnapshot({...value,accounts:[{...value.accounts[0],fable_pct:101}]})).toThrow();
});

test('missing and null telemetry publish null estimates with no samples', () => {
 for (const fields of [{}, {quota:null,model_quotas:null}, {quota:{signals:{}},model_quotas:{}}]) {
  const value=enrich({files:[{id:'fixture',provider:'claude',account_type:'oauth',...fields}]},[],now);
  expect(value.history).toEqual([]);
  for(const key of ['weekly_pct','fable_pct','burn_weekly_pct_per_hour','burn_fable_pct_per_hour',
    'projected_weekly_empty_at','projected_fable_cap_at']) expect(value.accounts[0]![key as keyof typeof value.accounts[0]]).toBeNull();
 }
});

test('16-hour-old observations never advertise an active account', () => {
 const old = now - 16 * 3600000;
 const account = enrich(fixture(old, '0.44'), [], now).accounts[0]!;
 expect(account).toMatchObject({stale:true, observation_age_s:57600, status:'stale', last_status:'allowed', active:false});
 expect(account.weekly_pct).toBe(44);
});

test('freshness uses the newest weekly or Fable observation and the five-minute boundary', async () => {
 const {ACCOUNT_STALE_MS} = await import('../../src/usage/snapshot');
 const at = now - ACCOUNT_STALE_MS;
 expect(enrich(fixture(at,'0.44'),[],now).accounts[0]).toMatchObject({stale:false,status:'allowed',active:true,observation_age_s:300});
 expect(enrich(fixture(at-1,'0.44'),[],now).accounts[0]).toMatchObject({stale:true,status:'stale',active:false});
 const input = fixture(now-16*3600000,'0.44');
 input.files[0]!.model_quotas['claude-fable-5-2'].observed_at = new Date(now).toISOString();
 expect(enrich(input,[],now).accounts[0]).toMatchObject({stale:false,status:'allowed',active:true,observation_age_s:0});
 input.files[0]!.quota.observed_at = new Date(now).toISOString();
 input.files[0]!.model_quotas['claude-fable-5-2'].observed_at = new Date(at-1).toISOString();
 expect(enrich(input,[],now).accounts[0]).toMatchObject({stale:false,active:true});
});

test('missing and future observations cannot advertise current room', () => {
 const missing = enrich({files:[{id:'fixture',provider:'claude',account_type:'oauth'}]},[],now);
 expect(missing.accounts[0]).toMatchObject({stale:true,status:'stale',last_status:'unknown',active:false,observation_age_s:null});
 expect(enrich(fixture(now+60000,'0.44'),[],now).accounts[0]).toMatchObject({stale:true,status:'stale',active:false});
});

test('outages re-age accounts, retain raw status, and accept pre-freshness snapshots', async () => {
 const {staleSnapshot} = await import('../../src/usage/snapshot');
 const {history, ...value} = enrich(fixture(now,'0.44'),[],now);
 const aged = staleSnapshot(value,now+16*3600000);
 expect(aged.accounts[0]).toMatchObject({stale:true,status:'stale',last_status:'allowed',active:false,observation_age_s:57600});
 expect(staleSnapshot(aged,now+17*3600000).accounts[0]).toMatchObject({last_status:'allowed',observation_age_s:61200});
 const {stale,observation_age_s,last_status,...legacy} = value.accounts[0]!;
 expect(staleSnapshot({...value,accounts:[legacy]},now+16*3600000).accounts[0]).toMatchObject({stale:true,status:'stale',active:false});
 for (const patch of [{last_status:'opaque'}, {stale:'yes'}, {observation_age_s:-1}]) {
  expect(() => staleSnapshot({...value,accounts:[{...value.accounts[0],...patch}]},now)).toThrow();
 }
});
