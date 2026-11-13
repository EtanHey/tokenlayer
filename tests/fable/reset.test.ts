import {expect,test} from 'bun:test';
import {resetPressed,type ResetState} from '../../src/fable/reset';
import {defaults} from '../../src/fable/core';
test('consumption persists before POST; ambiguous recovery retry never decrements twice',async()=>{
 const s:ResetState={...defaults(),resets:{a:{left:2,confirmedByEtan:true}},resetOps:{}};
 let posts=0,persisted='';const events:unknown[]=[];
 const hub={request:async()=>{posts++;expect(JSON.parse(persisted).resets.a.left).toBe(1);throw Error('lost response');},observations:async()=>[{id:'a',auth_index:'index',cooldowns:posts?[]:[{scope:'credential'}]}]};
 await resetPressed(s,'a','index','op',true,hub,()=>{persisted=JSON.stringify(s);},e=>events.push(e));
 expect(s.resets!.a.left).toBe(1);expect(s.resetOps!.op.recovery).toBe('recovered');
 await resetPressed(s,'a','index','op',true,hub,()=>{},e=>events.push(e));expect(posts).toBe(1);
 await expect(resetPressed(s,'other','index','op',true,hub,()=>{},()=>{})).rejects.toThrow('operation account mismatch');
});
test('unconfirmed count is UNKNOWN; failed recovery is independent',async()=>{
 const s:ResetState={...defaults()};const hub={request:async()=>{},observations:async()=>[{id:'a',cooldowns:[{scope:'credential'}]}]};
 await resetPressed(s,'a','index','op',false,hub,()=>{},()=>{});
 expect(s.resets!.a.left).toBe(null);expect(s.resetOps!.op.recovery).toBe('failed');
});

test('failed recovery retries without consuming again',async()=>{
 const s:ResetState={...defaults(),resets:{a:{left:2,confirmedByEtan:true}}};let posts=0;
 const hub={request:async()=>{posts++},observations:async()=>[{id:'a',cooldowns:posts<2?[{scope:'credential'}]:[]}]};
 await resetPressed(s,'a','index','retry',true,hub,()=>{},()=>{});
 expect(s.resetOps!.retry.recovery).toBe('failed');
 await resetPressed(s,'a','index','retry',true,hub,()=>{},()=>{});
 expect(s.resetOps!.retry.recovery).toBe('recovered');expect(s.resets!.a.left).toBe(1);expect(posts).toBe(2);
});

test('no cooldown is not_needed; replay never consumes twice',async()=>{
 const s:ResetState={...defaults(),resets:{a:{left:2,confirmedByEtan:true}}};let posts=0;
 const hub={request:async()=>{posts++},observations:async()=>[{id:'a',auth_index:'index',cooldowns:[]}]};
 await resetPressed(s,'a','index','no-cooldown',true,hub,()=>{},()=>{});
 expect(s.resetOps!['no-cooldown'].recovery).toBe('not_needed');
 await resetPressed(s,'a','index','no-cooldown',true,hub,()=>{},()=>{});
 expect(s.resets!.a.left).toBe(1);expect(posts).toBe(1);
});
