import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { defaults, plan, type Observation } from '../fable/core';
import { Hub, locked, execute, save, event, statePath } from '../fable/io';
import { resetPressed, type ResetState } from '../fable/reset';
import { loadEnvFiles } from '../lib/env';
import { ClickHouse } from '../lib/clickhouse';
export const coverage = ['M4 direct mode (~/.config/tokenlayer/direct.json, blank base URL)', 'Claude apps and claude.ai', 'api/<model> paid-key traffic'];
export function quota(q: Observation['quota'], window: string) {
 const signals=Object.fromEntries(Object.entries(q?.signals??{}).map(([k,v])=>[k.toLowerCase(),v]));
 const prefix='anthropic-ratelimit-unified-'+window+'-';
 const raw=signals[prefix+'utilization'];
 return {utilization:raw===undefined?null:Number(raw), status:signals[prefix+'status']??'UNKNOWN',reset:signals[prefix+'reset']??null,observed_at:q?.observed_at??null,stale:!q?.observed_at||Date.now()-Date.parse(q.observed_at)>300000};
}
export const metricsSQL=(hours:number)=>`SELECT credential, model, toStartOfHour(ts) AS hour, count() AS requests, sum(total_tokens) AS tokens, countIf(status_code=429) AS errors429 FROM tokenlayer.proxy_usage FINAL WHERE ts >= now() - INTERVAL ${hours} HOUR GROUP BY credential, model, hour ORDER BY hour`;
export function createHandler(o:{logins:string[];origin:string;secret:string;hub:Hub;ch:Pick<ClickHouse,'queryJSON'>;path?:string;events?:string;page?:(token:string)=>string}) {
 const path=o.path??statePath();
 const load=():ResetState=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):defaults();
 const token=(login:string)=>createHmac('sha256',o.secret).update(login).digest('hex');
 const history=()=>{const p=o.events??process.env.TOKENLAYER_FABLE_EVENTS??join(homedir(),'.local/state/tokenlayer/fable/events.jsonl');return existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).slice(-50).map(x=>JSON.parse(x)):[]};
 return async (r:Request):Promise<Response>=>{
 const login=r.headers.get('Tailscale-User-Login')??'';
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 if(!login||!o.logins.includes(login))return json({error:'Forbidden'},403);
 const u=new URL(r.url);
 if(r.method==='POST') {const actual=Buffer.from(r.headers.get('X-CSRF-Token')??''); const wanted=Buffer.from(token(login));if(r.headers.get('Origin')!==o.origin||actual.length!==wanted.length||!timingSafeEqual(actual,wanted))return json({error:'Forbidden'},403);}
 try {
 if(r.method==='GET'){
 if(u.pathname==='/')return new Response(o.page?.(token(login))??`<meta name="csrf-token" content="${token(login)}"><h1>Fable dashboard API</h1>`,{headers:{'Content-Type':'text/html','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"}});
 if(u.pathname==='/api/state')return json({state:load(),events:history(),coverage});
 if(u.pathname==='/api/accounts')return json(await accounts());
 if(u.pathname==='/api/metrics'){if(!['48h','7d'].includes(u.searchParams.get('window')??'48h'))return json({error:'Invalid window'},400);return json({rows:await o.ch.queryJSON(metricsSQL(u.searchParams.get('window')==='7d'?168:48)),freshness:await o.ch.queryJSON('SELECT max(ts) AS last_at FROM tokenlayer.proxy_usage')});}
 if(u.pathname==='/api/burn')return json(await burn());
 if(u.pathname==='/api/recommendation')return json((await accounts()).map(c=>{const f=c.fable.utilization===null?null:c.fable.utilization*.5;const hours=(Number(c.weekly.reset)*1000-Date.now())/3600000;const eligible=c.fable.status==='rejected'||(c.fable.utilization??0)>=.95||((c.weekly.utilization??0)>=.95&&(f??0)>.1);return {account:c.email,verdict:c.weekly.stale||c.fable.stale?'UNKNOWN':eligible?'consider':'wait',reason:eligible?'Fable refill or weekly rescue; confirm work cannot wait or use another account. '+(hours<36?'Under 36h: wait unless urgent or resets expiring.':'36h heuristic; urgency and expiry may override.'):'No cap trigger observed; urgent work may justify an override.',worthPctOfWeek:f===null?null:f*100};}));
 }
 if(r.method==='POST'&&['/api/switch','/api/resets','/api/reset-pressed'].includes(u.pathname)) {
 const body=await r.json();
 return await locked(async()=>{const s=load(),obs=await o.hub.observations(),c=obs.find(c=>c.email===body.account);const op=body.opId??crypto.randomUUID();if(typeof op!=='string'||!op||op.length>160)return json({error:'Invalid operation'},400);const emit=(e:unknown)=>event({...e as object,who:login});
 if(u.pathname==='/api/switch'){
 if(!['off','manual'].includes(body.mode)||typeof body.strict!=='boolean'||typeof body.spillover!=='boolean'||(body.mode==='manual'&&!c))return json({error:'Invalid switch'},400);
 if(s.ops[op]==='done')return json({state:s,opId:op});
 s.mode=body.mode;s.fableAccount=body.account??s.fableAccount;s.strictFableAccount=body.strict;s.spillover=body.spillover;
 if(!Object.keys(s.baseline).length){if(obs.length!==2)throw Error();for(const c of obs)s.baseline[c.id]=o.hub.metadata(c.id);}
 save(s,path);await execute(s,plan(s,obs).desired,o.hub,op,s=>save(s,path),emit);
 }else{
 if(!c)return json({error:'Unknown account'},400);
 if(u.pathname==='/api/resets'){if(!(body.left===null||Number.isInteger(body.left)&&body.left>=0&&body.left<=3)||typeof body.confirmed!=='boolean')return json({error:'Invalid count'},400);s.resets??={};s.resets[body.account]={left:body.left,confirmedByEtan:body.confirmed};save(s,path);}
 else {if(!c.auth_index||!body.opId)return json({error:'Operation id required'},400);await resetPressed(s,body.account,c.auth_index,op,true,o.hub,()=>save(s,path),emit);}
 }
 emit({at:new Date().toISOString(),op,stage:u.pathname.slice(5),account:body.account,status:'done'});return json({state:s,opId:op});},path);
 }
 return json({error:'Not found'},404);
 }catch{return json({error:'Dashboard operation unavailable; retry with the same operation id'},503);}
 };
 async function accounts(){return (await o.hub.observations()).map(c=>({id:c.id,email:c.email,status:c.status,cooldowns:c.cooldowns,weekly:quota(c.quota,'7d'),fable:quota(c.model_quotas?.['claude-fable-5-2'],'7d_oi'),exclusions:o.hub.metadata(c.id)}));}
 async function burn(){const rows=await o.ch.queryJSON<{credential:string;window:string;ts:string;utilization:number|null}>(`SELECT credential, 'weekly' AS window, ts, utilization_7d AS utilization FROM tokenlayer.credentials_snap WHERE ts >= now() - INTERVAL 6 HOUR UNION ALL SELECT credential, 'fable' AS window, ts, toFloat64OrNull(signals['anthropic-ratelimit-unified-7d_oi-utilization']) AS utilization FROM tokenlayer.credentials_snap WHERE ts >= now() - INTERVAL 6 HOUR ORDER BY credential, window, ts`);const groups=new Map<string,typeof rows>();for(const r of rows){const key=r.credential+':'+r.window;groups.set(key,[...(groups.get(key)??[]),r]);}return {estimate:true,rows,projections:[...groups].map(([key,rs])=>{const valid=rs.filter(r=>r.utilization!==null),a=valid[0],b=valid.at(-1);const hours=a&&b?(Date.parse(b.ts+'Z')-Date.parse(a.ts+'Z'))/3600000:0;const rate=hours>0?(b!.utilization!-a!.utilization!)/hours:0;return {key,perHour:rate>0?rate:null,projectedCapAt:rate>0?new Date(Date.now()+Math.max(0,1-b!.utilization!)/rate*3600000).toISOString():null};})};}
}
export function start(page?:(token:string)=>string){const env=loadEnvFiles(['~/.config/tokenlayer/hub.env','~/.config/tokenlayer/clickhouse.env']);return Bun.serve({hostname:'127.0.0.1',port:Number(env.TOKENLAYER_DASHBOARD_PORT??8446),fetch:createHandler({logins:(env.TOKENLAYER_DASHBOARD_LOGINS??'').split(',').map(x=>x.trim()).filter(Boolean),origin:env.TOKENLAYER_DASHBOARD_ORIGIN??'https://locals-macbook-pro.tail5ef6be.ts.net:8446',secret:crypto.randomUUID(),hub:new Hub(env.TOKENLAYER_HUB_URL??'http://127.0.0.1:8317',env.CLIPROXY_MGMT_KEY??''),ch:ClickHouse.fromEnv(env),page})});}
if(import.meta.main)start();
