import { expect, test } from 'bun:test';
import fixture from '../fixtures/steer/credentials-live-redacted.json';
import { snapshot, staleSnapshot } from '../../src/usage/snapshot';
const now = Date.parse('2026-10-28T09:00:00Z');
test('fixture produces only safe exact account fields', () => {
  const result = snapshot(fixture, now);
  expect(result.generated_at).toBe('2026-10-28T09:00:00.000Z');
  expect(result.accounts).toHaveLength(2);
  expect(result.accounts[0]).toEqual({ label: expect.stringMatching(/^[a-f0-9]{16}$/), active: true, five_hour: { used_pct: 64, resets_at: '2026-10-28T12:50:00.000Z' }, weekly: { used_pct: 10, resets_at: '2026-10-30T19:00:00.000Z' }, status: 'allowed', priority: 0, disabled: false });
  expect(JSON.stringify(result)).not.toMatch(/@|sk-|Bearer/);
});
test('priority wins, blocked credentials cannot be active, ties follow rank', () => {
  const files = fixture.files.map((c, i) => ({ ...c, priority: i ? 100 : 50 }));
  expect(snapshot({files}, now).accounts.map(c => c.active)).toEqual([false, true]);
  files[1].disabled = true;
  expect(snapshot({files}, now).accounts.map(c => c.active)).toEqual([true, false]);
});
test('outage keeps accounts and timestamp, discards arbitrary errors', () => {
  const previous = snapshot(fixture, now);
  expect(staleSnapshot(previous)).toEqual({...previous, stale:true, last_error:'hub unavailable'});
  expect(() => snapshot({files:[{id:'bad'}]}, now)).toThrow();
});
test('opaque labels and allowlist discard secrets even in credential IDs', () => {
  const result = snapshot({files: [{...fixture.files[0], id:'person@example.com-sk-1234567890', access_token:'arbitrary-secret'}]}, now);
  expect(JSON.stringify(result)).not.toMatch(/@|sk-|Bearer|arbitrary-secret/);
});
test('unknown windows stay null and empty fleet has no active account', () => {
  const result = snapshot({files:[{id:'unknown',provider:'claude',account_type:'oauth'}]},now);
  expect(result.accounts[0]?.five_hour).toEqual({used_pct:null,resets_at:null});
  expect(result.accounts[0]?.status).toBe('unknown');
  expect(snapshot({files:[]},now).accounts).toEqual([]);
});

test('labels share hub credential identity with steer and drain', async()=>{
 const {labelHash}=await import('../../src/lib/hash');
 const c={...fixture.files[0]!,id:'synthetic@example.invalid',auth_index:'hub-id'};
 expect(snapshot({files:[c]},now).accounts[0]!.label).toBe(labelHash(c.auth_index));
 const {auth_index, ...withoutIndex} = c;
 expect(snapshot({files:[withoutIndex]},now).accounts[0]!.label).toBe(labelHash(c.id));
});

for (const present of ['5h','7d']) test(`only ${present} signals mark the other window absent and survive stale validation`, () => {
  const data = snapshot({files:[{id:'one-window',provider:'claude',account_type:'oauth',quota:{signals:{
    [`Anthropic-Ratelimit-Unified-${present}-Utilization`]:'0.12',
  }}}]},now);
  expect(data.accounts[0]![present === '5h' ? 'weekly' : 'five_hour']).toEqual({used_pct:null,resets_at:null,absent:true});
  expect(staleSnapshot(data).accounts).toEqual(data.accounts);
});
test('partial present signals stay unknown rather than absent', () => {
  const data = snapshot({files:[{id:'partial',provider:'claude',account_type:'oauth',quota:{signals:{'anthropic-ratelimit-unified-5h-status':'allowed'}}}]},now);
  expect(data.accounts[0]!.five_hour).toEqual({used_pct:null,resets_at:null});
});
