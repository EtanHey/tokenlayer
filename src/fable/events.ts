import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ClickHouse} from '../lib/clickhouse';
/** Durable local JSONL is the source; deterministic batch tokens make retries idempotent. */
export async function shipEvents(ch:ClickHouse,path=process.env.TOKENLAYER_FABLE_EVENTS??join(homedir(),'.local/state/tokenlayer/fable/events.jsonl')) {
 if(!existsSync(path))return;
 const text=readFileSync(path,'utf8');const lines=text.split('\n');lines.pop();
 for(let i=0;i<lines.length;i++){const batch=lines.slice(i,i+1);const rows=batch.map(line=>{const e=JSON.parse(line);return {ts:e.at.replace('T',' ').replace('Z',''),op:e.op,stage:e.stage,payload:line};});
  await ch.insert('fable_switch_events',rows,'fable-'+createHash('sha256').update(batch.join('\n')).digest('hex'));
 }
}
