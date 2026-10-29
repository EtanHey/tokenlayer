import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const now = '2026-10-29T12:00:00Z';
const account = (used = 20, elapsed = 300) => ({ label: 'claude-a1b2c3d4', disabled: false, status: 'allowed', five_hour: { used_pct: used, resets_at: new Date(Date.parse(now) + (300-elapsed)*60000).toISOString() }, weekly: { used_pct: 20 } });
const snapshot = (accounts: unknown[] = [account()]) => ({ generated_at: now, stale: false, accounts });
const cases = [
  { name: '59', data: snapshot([account(59)]), args: [], admit: true, level: 'green' },
  { name: '60', data: snapshot([account(60)]), args: [], admit: false, level: 'brake60' },
  { name: '79', data: snapshot([account(79)]), args: [], admit: false, level: 'brake60' },
  { name: '80', data: snapshot([account(80)]), args: [], admit: false, level: 'brake80' },
  ...[4,5].map(n => ({ name: `60 lead ${n}`, data: snapshot([account(60)]), args: ['--kind','lead','--active-leads',String(n)], admit: n<5, level: 'brake60' })),
  ...[2,3].map(n => ({ name: `80 essential ${n}`, data: snapshot([account(80)]), args: ['--kind','lead','--active-leads',String(n),'--essential'], admit: n<3, level: 'brake80' })),
  { name: 'nonessential', data: snapshot([account(80)]), args: ['--kind','lead','--active-leads','0'], admit: false, level: 'brake80' },
  { name: 'lead count required', data: snapshot(), args: ['--kind','lead'], admit: false, level: 'no-headroom' },
  { name: 'stale', data: { ...snapshot(), stale:true }, args: [], admit:false, level:'no-headroom' },
  { name: 'old', data: { ...snapshot(), generated_at:'2026-10-29T11:56:59Z' }, args: [], admit:false, level:'no-headroom' },
  { name: '180 seconds', data: { ...snapshot(), generated_at:'2026-10-29T11:57:00Z' }, args: [], admit:true, level:'green' },
  { name: 'future', data: { ...snapshot(), generated_at:'2026-10-29T12:01:00Z' }, args: [], admit:false, level:'no-headroom' },
  { name: 'weekly rejected', data: snapshot([{ ...account(0), weekly: { used_pct:0, status:'rejected' } }]), args: [], admit:false, level:'no-headroom' },
  { name: 'mixed rejected', data: snapshot([account(), { ...account(), status:'rejected' }]), args: [], admit:true, level:'green' },
  { name: 'unknown', data: snapshot([{ ...account(), status:'unknown' }]), args: [], admit:false, level:'no-headroom' },
  { name: 'weekly exhausted', data: snapshot([{ ...account(), weekly:{ used_pct:100 } }]), args: [], admit:false, level:'no-headroom' },
  { name: 'no accounts', data: snapshot([]), args: [], admit:false, level:'no-headroom' },
  { name: 'disabled ignored', data: snapshot([account(), { ...account(100), disabled:true, status:'rejected' }]), args: [], admit:true, level:'green' },
  { name: 'worst account', data: snapshot([account(), account(80)]), args: [], admit:false, level:'brake80' },
  { name: 'pacing edge', data: snapshot([account(40,150)]), args: [], admit:true, level:'green' },
  { name: 'pacing warning', data: snapshot([account(40,149)]), args: [], admit:false, level:'brake60' },
  { name: 'pacing lead', data: snapshot([account(40,149)]), args: ['--kind','lead','--active-leads','0'], admit:true, level:'green' },
  { name: 'healthy and weekly rejected lead', data: snapshot([account(15), { ...account(), weekly: { used_pct:99, status:'rejected' } }]), args: ['--kind','lead','--active-leads','0'], admit:true, level:'green' },
  { name: 'both rejected', data: snapshot([{ ...account(), status:'rejected' }, { ...account(), weekly:{used_pct:99,status:'rejected'} }]), args: [], admit:false, level:'no-headroom' },
  ...[4,5].map(n => ({ name: `mixed 61 lead ${n}`, data: snapshot([account(61), {...account(),status:'rejected'}]), args:['--kind','lead','--active-leads',String(n)], admit:n<5, level:'brake60' })),
  { name: 'mixed 61 worker', data: snapshot([account(61), {...account(),status:'rejected'}]), args:[], admit:false, level:'brake60' },
  { name: 'unknown and healthy', data: snapshot([{...account(),status:'unknown'},account(15)]), args:[], admit:true, level:'green' },
  { name: 'five hour rejected and healthy', data: snapshot([{...account(),five_hour:{...account().five_hour,status:'rejected'}},account(15)]), args:[], admit:true, level:'green' },
  { name: 'malformed and healthy', data: snapshot([account(),{...account(),five_hour:{used_pct:'bad'}}]), args:[], admit:false, level:'no-headroom' },
];
for (const c of cases) test(c.name, () => {
  const dir = mkdtempSync(join(tmpdir(),'admit-'));
  try {
    const file = join(dir,'usage.json'); writeFileSync(file,JSON.stringify(c.data));
    const p = Bun.spawnSync([process.execPath,'src/admit/main.ts','--kind','claude.judgment','--file',file,'--now',now,...c.args]);
    const result = JSON.parse(p.stdout.toString());
    expect(p.exitCode).toBe(c.admit ? 0 : 1);
    expect(result).toMatchObject({ admit:c.admit, level:c.level });
    expect(typeof result.reason).toBe('string'); expect(Array.isArray(result.accounts)).toBe(true);
    expect(result.pacing).toHaveProperty('warn');
    for (const assessment of result.accounts) expect(assessment.label).toBe('claude-a1b2c3d4');
    if(c.name === 'pacing edge') expect(result.pacing).toEqual({used:40,elapsed_min:150,score:80,warn:false});
    if(c.name === 'pacing warning') expect(result.pacing.warn).toBe(true);
    expect(p.stderr.toString()).toBe('');
  } finally { rmSync(dir,{recursive:true}); }
});
for (const content of [null,'{','{}']) test(`invalid input ${content}`, () => {
  const dir = mkdtempSync(join(tmpdir(),'admit-')); const file = join(dir,'usage.json');
  try {
    if(content !== null) writeFileSync(file,content);
    const p = Bun.spawnSync([process.execPath,'src/admit/main.ts','--kind','claude.subagent.cheap','--file',file,'--now',now]);
    expect(p.exitCode).toBe(1); expect(JSON.parse(p.stdout.toString())).toMatchObject({admit:false,level:'no-headroom'});
  } finally {rmSync(dir,{recursive:true});}
});
