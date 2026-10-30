import { dryRun, sha256, type Entry, type Event } from "./pipeline";
import { newFileState, parseLine } from "../ship/parse";
import { startLocalClickHouse } from "../lib/local-clickhouse";
import { applySchema } from "../lib/schema";

/** Both the baseline and sample live only in an owned throwaway instance. */
export async function validatedDryRun(entries: Entry[], options: Parameters<typeof dryRun>[1], seedRows = 7) {
  if (!Number.isSafeInteger(seedRows) || seedRows < 1 || seedRows > 100) throw Error("invalid validation seed count");
  if (process.env.USER === "happycampr") throw Error("archaeology validation is M4-only");
  const local = await startLocalClickHouse();
  try {
    await applySchema(local.client);
    const raw = "{}\n", parsed = parseLine(raw, newFileState("claude","claude",Date.parse("2026-01-01")));
    const seeds: Event[] = Array.from({length:seedRows},(_,i)=>({...parsed,raw,session_id:"validation-baseline",machine:"validation",harness:"claude",path:"validation://baseline",generation:"validation",byte_offset:i,line_bytes:raw.length,content_hash:sha256(Buffer.from(raw))}));
    await local.client.insert("session_events",seeds);
    const count = async () => (await local.client.queryJSON<{n:number}>("SELECT toUInt32(count()) AS n FROM tokenlayer.session_events FINAL"))[0].n;
    const before=await count();
    const report=await dryRun(entries,options);
    const after=await count();
    if(before!==seedRows || after!==before) throw Error("dry-run changed preseeded ClickHouse rows");
    await local.client.exec("CREATE TABLE tokenlayer.archaeology_sample AS tokenlayer.session_events");
    await local.client.insert("archaeology_sample",report.sample);
    const stored=await local.client.queryJSON<{raw:string;content_hash:string}>("SELECT raw,content_hash FROM tokenlayer.archaeology_sample FINAL");
    if(stored.length!==report.sample.length || stored.some(r=>sha256(Buffer.from(r.raw))!==r.content_hash || !report.sample.some(s=>s.raw===r.raw&&s.content_hash===r.content_hash))) throw Error("ClickHouse raw/hash sample mismatch");
    const afterSample=await count();
    if(afterSample!==before) throw Error("sample validation changed baseline rows");
    return {report,validated:stored.length,baseline:{seed_rows:seedRows,before,after,after_sample:afterSample}};
  } finally {await local.stop();}
}
