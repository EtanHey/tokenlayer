import { dryRun, sha256, type Entry, type Event } from "./pipeline";
import { newFileState, parseLine } from "../ship/parse";
import { startLocalClickHouse } from "../lib/local-clickhouse";
import { applySchema } from "../lib/schema";
import type { ClickHouse } from "../lib/clickhouse";

/** Write/read the actual sample, checking bytes rather than a dry-run-only baseline. */
export async function validateSample(client: ClickHouse, sample: Event[]): Promise<number> {
  await client.exec("CREATE TABLE tokenlayer.archaeology_sample AS tokenlayer.session_events");
  await client.insert("archaeology_sample", sample);
  const stored=await client.queryJSON<{raw:string;content_hash:string}>("SELECT raw,content_hash FROM tokenlayer.archaeology_sample FINAL");
  if(stored.length!==sample.length || stored.some(r=>sha256(Buffer.from(r.raw))!==r.content_hash || !sample.some(s=>s.raw===r.raw&&s.content_hash===r.content_hash))) throw Error("ClickHouse raw/hash sample mismatch");
  return stored.length;
}

/** Both the baseline and sample live only in an owned throwaway instance. */
export async function validatedDryRun(entries: Entry[], options: Parameters<typeof dryRun>[1], seedRows = 7) {
  if (!Number.isSafeInteger(seedRows) || seedRows < 1 || seedRows > 100) throw Error("invalid validation seed count");
  if (process.env.USER === "happycampr") throw Error("archaeology validation is M4-only");
  const pending = startLocalClickHouse();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= pending.then(local => local.stop());
  const interrupt = () => { void stop().finally(() => process.exit(130)); };
  const terminate = () => { void stop().finally(() => process.exit(143)); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    const local = await pending;
    await applySchema(local.client);
    const raw = "{}\n", parsed = parseLine(raw, newFileState("claude","claude",Date.parse("2026-01-01")));
    const seeds: Event[] = Array.from({length:seedRows},(_,i)=>({...parsed,raw,session_id:"validation-baseline",machine:"validation",harness:"claude",path:"validation://baseline",generation:"validation",byte_offset:i,line_bytes:raw.length,content_hash:sha256(Buffer.from(raw))}));
    await local.client.insert("session_events",seeds);
    const count = async () => (await local.client.queryJSON<{n:number}>("SELECT toUInt32(count()) AS n FROM tokenlayer.session_events FINAL"))[0].n;
    const before=await count();
    if(before!==seedRows) throw Error("validation baseline seed mismatch");
    const report=await dryRun(entries,options);
    const validated = await validateSample(local.client, report.sample);
    const afterSample=await count();
    if(afterSample!==before) throw Error("sample validation changed baseline rows");
    return {report,validated,baseline:{seed_rows:seedRows,before,after_sample:afterSample}};
  } finally {
    try { await stop(); }
    finally { process.removeListener("SIGINT",interrupt); process.removeListener("SIGTERM",terminate); }
  }
}
