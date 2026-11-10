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
