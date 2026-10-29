import { test, expect } from 'bun:test';
import { snapshot as usageSnapshot, staleSnapshot } from '../../src/usage/snapshot';
import { evaluate } from '../../src/admit/admit';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import five from '../fixtures/admit/producer-five.json';
import weekly from '../fixtures/admit/producer-weekly.json';
const now = '2026-03-02T12:00:00.000Z';
const account = () => ({ label:'claude-a1b2c3d4', disabled:false, status:'allowed', five_hour:{used_pct:20,resets_at:now}, weekly:{used_pct:20} });
const snapshot = () => ({ generated_at:now, stale:false, accounts:[account()] });
function cli(data: unknown, time = now, kind = 'claude.judgment') {
  const dir = mkdtempSync(join(tmpdir(),'admit-r2-'));
  try {
    const file = join(dir,'usage.json'); writeFileSync(file,JSON.stringify(data));
    const p = Bun.spawnSync([process.execPath,'src/admit/main.ts','--file',file,'--now',time,'--kind',kind,...(kind === 'lead' ? ['--active-leads','0'] : [])]);
    expect(p.stderr.toString()).toBe('');
    return { exit:p.exitCode, result:JSON.parse(p.stdout.toString()) };
  } finally { rmSync(dir,{recursive:true}); }
}
for (const [missing,data] of [['five',five],['weekly',weekly]] as const)
for (const kind of ['lead','claude.judgment','claude.subagent.cheap','claude.subagent.mechanical'])
test(`producer null ${missing}: ${kind}`, () => {
  expect(cli(data,data.generated_at,kind)).toMatchObject({exit:0,result:{admit:true,level:'green',accounts:[{label:'claude-bb03e678'}]}});
  expect(cli({...data,accounts:[data.accounts[1]]},data.generated_at,kind)).toMatchObject({exit:1,result:{admit:false,level:'no-headroom',accounts:[]}});
});
for (const field of ['generated_at','reset','now']) for (const invalid of ['2026-02-30T12:00:00.000Z','2026-03-02T12:00:00+24:00','March 2, 2026 12:00 UTC','2026-03-02T12:00:00+00:60','2026-03-02T24:00:00Z'])
test(`invalid ${field}: ${invalid}`, () => {
  const data = snapshot();
  if (field === 'generated_at') data.generated_at = invalid;
  if (field === 'reset') data.accounts[0]!.five_hour.resets_at = invalid;
  expect(cli(data,field === 'now' ? invalid : now)).toMatchObject({exit:1,result:{admit:false,level:'no-headroom',accounts:[]}});
});
for (const label of ['Bearer REVIEW_FAKE_ONLY_SECRET_019a18505','synthetic','claude-ABCDEF12','claude-deadbeef\n'])
test('replace non-producer label safely', () => {
  const data = snapshot(); data.accounts[0]!.label = label;
  const output = cli(data);
  expect(output).toMatchObject({exit:0,result:{admit:true}});
  expect(output.result.accounts[0].label).toBe('[redacted]');
});
test('strict timestamps preserve leap days and timezone offsets', () => {
  for (const time of ['2024-02-29T12:00:00.000Z','2026-03-02T14:00:00+02:00','2026-03-02T07:00:00-05:00']) {
    const data = snapshot(); data.generated_at = time; data.accounts[0]!.five_hour.resets_at = time;
    expect(cli(data,time)).toMatchObject({exit:0,result:{admit:true}});
  }
});
test('malformed sibling remains invalid beside a null window', () => {
  const data = structuredClone(five); data.accounts[1]!.weekly.used_pct = 'bad' as never;
  expect(() => evaluate(data,{kind:'lead',activeLeads:0,essential:false,now:Date.parse(data.generated_at)})).toThrow();
});

// Claude's idle-deadlock reproduction, through the real producer.
test('two idle accounts regain headroom after their five-hour resets', () => {
  const data = producer();
  expect(data.accounts.map(a => a.five_hour)).toEqual([
    {used_pct:0,resets_at:null,rolled_over:true}, {used_pct:0,resets_at:null,rolled_over:true},
  ]);
  for (const kind of ['lead','claude.judgment','claude.subagent.cheap','claude.subagent.mechanical'])
    expect(cli(data,now,kind)).toMatchObject({exit:0,result:{admit:true,level:'green',pacing:{used:0,elapsed_min:null,score:0,warn:false}}});
  expect(staleSnapshot(data).accounts).toEqual(data.accounts);
});
function producer(rejected = false) {
  const ms = Date.parse(now);
  const files = [1,2].map(n => ({id:`idle-${n}`,provider:'claude',account_type:'oauth',status:'active',quota:{signals:{
    'anthropic-ratelimit-unified-5h-utilization':'0.42',
    'anthropic-ratelimit-unified-5h-reset':String((ms-n*3600000)/1000),
    'anthropic-ratelimit-unified-5h-status':rejected ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-7d-utilization':'0.30',
    'anthropic-ratelimit-unified-7d-reset':String((ms+3*86400000)/1000),
  }}}));
  return usageSnapshot({files},ms);
}
test('expired but rejected signals never manufacture headroom', () => {
  const data = producer(true);
  expect(data.accounts.every(a => a.status === 'rejected')).toBe(true);
  expect(cli(data)).toMatchObject({exit:1,result:{admit:false}});
});
for (const field of ['five_hour','weekly']) for (const reading of [null,
  {used_pct:null,resets_at:now}, {used_pct:20,resets_at:null}, {used_pct:null,resets_at:null}])
test(`partial null ${field} is per-account unknown: ${JSON.stringify(reading)}`, () => {
  const unknown = {...account(),[field]:reading};
  expect(cli({...snapshot(),accounts:[unknown,account()]})).toMatchObject({exit:0,result:{admit:true}});
  expect(cli({...snapshot(),accounts:[unknown]})).toMatchObject({exit:1,result:{admit:false}});
});
test('--now cannot replay the default production file', () => {
  const home = mkdtempSync(join(tmpdir(),'admit-clock-'));
  try {
    mkdirSync(join(home,'.config/tokenlayer'),{recursive:true});
    writeFileSync(join(home,'.config/tokenlayer/usage.json'),JSON.stringify(snapshot()));
    const p = Bun.spawnSync([process.execPath,'src/admit/main.ts','--kind','lead','--active-leads','0','--now',now],{env:{...process.env,HOME:home}});
    expect(p.exitCode).toBe(1);
    expect(JSON.parse(p.stdout.toString()).admit).toBe(false);
  } finally {rmSync(home,{recursive:true});}
});

test('both windows can roll over at the boundary; unknown is never inferred as rollover', () => {
  const ms = Date.parse(now);
  const data = usageSnapshot({files:[{id:'both',provider:'claude',account_type:'oauth',quota:{signals:{
    'Anthropic-Ratelimit-Unified-5h-Reset':String(ms/1000),
    'Anthropic-Ratelimit-Unified-7d-Reset':String(ms/1000),
  }}}]},ms);
  expect(data.accounts[0]!.weekly).toEqual({used_pct:0,resets_at:null,rolled_over:true});
  expect(cli(data)).toMatchObject({exit:0,result:{admit:true}});
  const unknown = usageSnapshot({files:[{id:'unknown',provider:'claude',account_type:'oauth'}]},ms);
  expect(unknown.accounts[0]!.five_hour).toEqual({used_pct:null,resets_at:null});
  expect(cli(unknown)).toMatchObject({exit:1,result:{admit:false}});
});
