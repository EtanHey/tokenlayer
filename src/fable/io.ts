import {readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,fsyncSync,appendFileSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {homedir} from 'node:os';
import {metadata,lists,same,type State,type Metadata,type Observation} from './core';
export const statePath=()=>process.env.TOKENLAYER_FABLE_STATE??join(homedir(),'.config/tokenlayer/fable-switch.json');
export function save(s:State,path=statePath()) {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const tmp=path+'.'+process.pid+'.tmp'; const fd=openSync(tmp,'wx',0o600);
 try {writeFileSync(fd,JSON.stringify(s));fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(tmp,path); const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
/** Kernel lock is shared with dashboard writers and released automatically on process death. */
export async function locked<T>(fn:()=>Promise<T>,path=statePath()):Promise<T> {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const {dlopen,FFIType}=await import('bun:ffi');
 const lib=dlopen(process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}});
 const fd=openSync(path+'.lock','a',0o600);
 try {for(let i=0;lib.symbols.flock(fd,6)!==0;i++){if(i>=100)throw Error('controller busy');await Bun.sleep(100);}return await fn();}
 finally{lib.symbols.flock(fd,8);closeSync(fd);lib.close();}
}
export class Hub {
 constructor(readonly url:string,private key:string,readonly authDir=join(homedir(),'.cli-proxy-api')){}
 async request(method:string,path:string,body?:unknown):Promise<any> {
  let r:Response;
  try {r=await fetch(this.url+'/v8/management'+path,{method,headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}catch{throw Error('hub transport failure');}
  if(!r.ok)throw Error('hub HTTP '+r.status); return r.json();
 }
 async observations():Promise<Observation[]> {return (await this.request('GET','/credentials')).files.filter((c:Observation)=>(c.provider??c.type)==='claude'&&c.account_type==='oauth');}
 metadata(id:string):Metadata {if(basename(id)!==id||!id.startsWith('claude-')||!id.endsWith('.json'))throw Error('unsafe credential name');return metadata(JSON.parse(readFileSync(join(this.authDir,id),'utf8')));}
 async catalog(id:string):Promise<string[]> {const r=await this.request('GET','/credentials/models?name='+encodeURIComponent(id));return (r.models??[]).map((m:any)=>m.id).sort();}
 async patch(id:string,value:unknown){await this.request('PATCH','/credentials/fields',{name:id,excluded_models:value});}
}
export function event(value:unknown) {
 const path=process.env.TOKENLAYER_FABLE_EVENTS??join(homedir(),'.local/state/tokenlayer/fable/events.jsonl');
 mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);
 try{appendFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
}
export interface ExecutorHub {metadata(id:string):Metadata;catalog(id:string):Promise<string[]>;patch(id:string,value:unknown):Promise<void>}
export async function execute(s:State,desired:Record<string,string[]>,hub:ExecutorHub,op:string,persist=(s:State)=>save(s),emit=event,afterExpand=async()=>{}) {
 if(s.ops[op]==='done') return;
 const ids=Object.keys(desired);if(ids.some(id=>!s.baseline[id]))throw Error('baseline required');
 s.ops[op]='pending';persist(s);
 async function apply(id:string,target:string[],stage:string) {
  if(same(lists(hub.metadata(id)),target)) {await hub.catalog(id);return;}
  emit({op,id,stage,at:new Date().toISOString(),target,status:'intent'});
  let ambiguous=false;try{await hub.patch(id,target.length?target:null);}catch{ambiguous=true;}
  const actual=hub.metadata(id), catalog=await hub.catalog(id);
  emit({op,id,stage,at:new Date().toISOString(),actual,catalog,ambiguous,status:'readback'});
  if(!same(lists(actual),target))throw Error('write unconfirmed; no further restriction');
  // Every explicitly excluded effective model must have disappeared.
  if(catalog.some(m=>target.some(rule=>new RegExp('^'+rule.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(m)))) throw Error('catalog exclusion unconfirmed');
 }
 for(const id of ids) {const current=lists(hub.metadata(id));await apply(id,current.filter(x=>desired[id].includes(x)),'expand');}
 await afterExpand();
 for(const id of ids) await apply(id,desired[id],'restrict');
 s.ops[op]='done';persist(s);
}
