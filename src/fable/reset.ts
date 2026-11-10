import type {State,Observation} from './core';
export type ResetState=State & {resets?:Record<string,{left:number|null;confirmedByEtan:boolean}>;resetOps?:Record<string,{account:string;recovery:'pending'|'failed'|'recovered';hint:string}>};
interface ResetHub {request(method:string,path:string,body?:unknown):Promise<unknown>;observations():Promise<Observation[]>}
/** A press reports a human action already taken; this never presses Anthropic's reset. Caller holds shared lock. */
export async function resetPressed(s:ResetState,account:string,index:string,op:string,confirmed:boolean,hub:ResetHub,persist:()=>void,emit:(e:unknown)=>void,skipCount=false) {
 s.resets??={};s.resetOps??={};
 if(s.resetOps[op]&&s.resetOps[op].account!==account)throw Error('operation account mismatch');
 if(s.resetOps[op]?.recovery==='recovered')return;
 if(!s.resetOps[op]) {
  if(!skipCount){const prior=s.resets[account];s.resets[account]={left:confirmed&&prior?.confirmedByEtan&&prior.left!==null?Math.max(0,prior.left-1):null,confirmedByEtan:confirmed&&!!prior?.confirmedByEtan};}
  s.resetOps[op]={account,recovery:'pending',hint:''};persist();
  emit({op,account,at:new Date().toISOString(),stage:'reset-consumed',count:skipCount?'test-skipped':s.resets[account].left??'UNKNOWN'});
 }
 try {await hub.request('POST','/routing/cooldown/reset',{auth_index:index});}catch{/* response loss is ambiguous: read back */}
 let recovered=false;
 try{const c=(await hub.observations()).find(c=>c.id===account);recovered=!!c&&Array.isArray(c.cooldowns)&&c.cooldowns.length===0;}catch{}
 s.resetOps[op].recovery=recovered?'recovered':'failed';
 s.resetOps[op].hint=recovered?'':'Retry recovery with the same operation id; reconcile UNKNOWN count with Etan.';
 persist();emit({op,at:new Date().toISOString(),stage:'reset-recovery',...s.resetOps[op]});
}
