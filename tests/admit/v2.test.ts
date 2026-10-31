import { expect, test } from 'bun:test';
import { evaluate, type Kind } from '../../src/admit/admit';
import { snapshot } from '../../src/usage/snapshot';
import ultra from '../fixtures/admit/ultra-7d.json';
const now = Date.parse('2026-10-31T08:50:00Z');
const absent = {used_pct:null,resets_at:null,absent:true};
const window = (used_pct: number, elapsed: number, length = 300) => ({used_pct,resets_at:new Date(now+(length-elapsed)*60000).toISOString()});
const account = (five_hour: unknown = absent, weekly: unknown = window(12,828,10080)) => ({label:'a1b2c3d4a1b2c3d4',disabled:false,status:'allowed',five_hour,weekly});
const check = (accounts: unknown[], kind: Kind = 'claude.judgment', activeLeads = 0, essential = false) => evaluate({generated_at:new Date(now).toISOString(),stale:false,accounts},{now,kind,activeLeads,essential});
test('Ultra 7d-only live shape at 12%, 13.8 hours admits; rejected sibling cannot veto', () => {
  const data = snapshot(ultra,now);
  const result = evaluate(data,{now,kind:'claude.judgment',activeLeads:0,essential:false});
  expect(result).toMatchObject({admit:true,level:'green',pacing:{weekly:{used:12,elapsed_min:828}}});
  expect(check([...data.accounts,{...account(),status:'rejected'}])).toMatchObject({admit:true,level:'green'});
});
for (const [name,five,weekly,level] of [
  ['late 5h',window(70,270),absent,'green'],
  ['fast 5h',window(50,100),absent,'slow'],
  ['95 threshold',window(95,299),absent,'stop'],
  ['96 percent',window(96,299),absent,'stop'],
  ['weekly fast',absent,window(30,1200,10080),'slow'],
  ['weekly early',absent,window(12,300,10080),'green'],
  ['projection exactly 100',window(50,150),absent,'green'],
  ['before 10%',window(50,29.99),absent,'green'],
  ['at 10%',window(50,30),absent,'slow'],
  ['missing reset', {used_pct:70,resets_at:null},absent,'green'],
  ['missing reset stop',absent,{used_pct:95,resets_at:null},'stop'],
  ['rollover',{used_pct:0,resets_at:null,rolled_over:true},absent,'green'],
  ['tightest present window',window(20,200),window(30,1200,10080),'slow'],
] as const) test(name, () => {
  const accounts = [account(five,weekly)];
  for (const kind of ['claude.judgment','claude.subagent.cheap','claude.subagent.mechanical'] as const)
    expect(check(accounts,kind)).toMatchObject({admit:level === 'green',level});
  for (const active of [0,1,2,4,5]) for (const essential of [false,true])
    expect(check(accounts,'lead',active,essential).admit).toBe(active < ({green:5,slow:2,stop:1}[level]) && (level !== 'stop' || essential));
});
test('pacing reports each present window; absent windows are omitted', () => {
  expect(check([account(absent,window(30,1200,10080))]).pacing).toEqual({weekly:{used:30,elapsed_min:1200,projected:252}});
  expect(check([account({used_pct:70,resets_at:null},absent)]).pacing).toEqual({five_hour:{used:70,elapsed_min:null,projected:null}});
  expect(check([account({used_pct:0,resets_at:null,rolled_over:true},absent)]).pacing).toEqual({five_hour:{used:0,elapsed_min:null,projected:0}});
});
test('best serving account wins regardless of order; disabled/enabled flags still filter', () => {
  const green = account(window(70,270),absent), stop = account(window(96,299),absent);
  for (const accounts of [[green,stop],[stop,green]]) expect(check(accounts)).toMatchObject({admit:true,level:'green'});
  expect(check([{...green,disabled:true},stop])).toMatchObject({admit:false,level:'stop'});
  expect(check([{...green,enabled:false},stop])).toMatchObject({admit:false,level:'stop'});
});
for (const a of [account(absent,absent),account(null),account({used_pct:null,resets_at:null}),
  {...account(),status:'unknown'},account(absent,{used_pct:12,status:'unknown'}),account(absent,{used_pct:100})])
  test('unknown or exhausted account cannot supply headroom', () => {
    expect(check([a])).toMatchObject({admit:false,level:'no-headroom'});
    expect(check([a,account()])).toMatchObject({admit:true,level:'green'});
  });
for (const field of ['five_hour','weekly']) for (const elapsed of [-1,0,10081]) test(`bad ${field} reset ${elapsed}`, () => {
  const length = field === 'five_hour' ? 300 : 10080;
  expect(() => check([{...account(),[field]:window(12,elapsed,length)}])).toThrow();
});
test('no unified signals remain unknown and deny', () => {
  const data = snapshot({files:[{id:'no-signals',provider:'claude',account_type:'oauth'}]},now);
  expect(evaluate(data,{now,kind:'claude.judgment',activeLeads:0,essential:false})).toMatchObject({admit:false,level:'no-headroom'});
});
