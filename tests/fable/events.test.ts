import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {shipEvents,shipBestEffort} from '../../src/fable/events';
test('cursor batches new lines, pins ambiguous retries, and isolates outage',async()=>{
 const dir=mkdtempSync(tmpdir()+'/fable-events-'),path=dir+'/events';
 const line=(op:string)=>JSON.stringify({op,at:new Date().toISOString(),stage:'test'})+'\n';
 try{
 writeFileSync(path,line('a')+line('b'));let calls:any[]=[];let fail=true;
 const ch={insert:async(...args:any[])=>{calls.push(args);if(fail)throw Error('outage');}};
 const logs:string[]=[];await shipBestEffort(ch,x=>logs.push(x),path);expect(logs.length).toBe(1);
 appendFileSync(path,line('c'));fail=false;await shipEvents(ch,path);
 expect(calls[0][2]).toBe(calls[1][2]);expect(calls[1][1].length).toBe(2);
 await shipEvents(ch,path);expect(calls[2][1].length).toBe(1);
 await shipEvents(ch,path);expect(calls.length).toBe(3);
 }finally{rmSync(dir,{recursive:true});}
});

test('permanent log faults alarm distinctly without exposing event contents', async () => {
 const dir=mkdtempSync(tmpdir()+'/fable-faults-'),path=dir+'/events';
 const ch={insert:async()=>{}};
 try {
  for (const [body,cursor,code] of [
   ['sentinel-private\n',undefined,'malformed_event'],
   ['', {offset:100,lineHash:''},'log_truncated'],
   ['changed\n', {offset:8,lineHash:'wrong'},'cursor_mismatch'],
   ['{}\n', {offset:0,lineHash:'',pendingEnd:100},'log_truncated'],
  ] as const) {
   writeFileSync(path,body); rmSync(path+'.cursor',{force:true});
   if(cursor)writeFileSync(path+'.cursor',JSON.stringify(cursor));
   const logs:string[]=[];await shipBestEffort(ch,x=>logs.push(x),path);
   expect(logs).toEqual([`fable: event shipping permanent fault (${code}); operator repair required; durable batch retained`]);
  }
 } finally {rmSync(dir,{recursive:true});}
});
