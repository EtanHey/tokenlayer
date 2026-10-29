import { test, expect } from "bun:test";
import { startLocalClickHouse, clickhouseBinary } from "../../src/lib/local-clickhouse";
import { manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { validatedDryRun } from "../../src/archaeology/validation";

test.skipIf(!clickhouseBinary())("S-5 dry-run leaves a preseeded real ClickHouse baseline unchanged", async () => {
  const bytes=Buffer.from('{"sessionId":"validation-fixture","type":"user"}\n');
  const row: Inventory={machine:"m4",source_kind:"archive_dir",container:"",member_path:"validation.jsonl",session_id:"validation-fixture",harness:"claude",bytes:String(bytes.length),lines:"1",first_ts:"2026-01-01",last_ts:"2026-01-01",cwd:"/Users/etanheyman/Gits/example",sha256:sha256(bytes),mtime:""};
  const result=await validatedDryRun(manifest([row],[]),{read:async()=>(async function*(){yield bytes;})()},3);
  expect(result.baseline).toEqual({seed_rows:3,before:3,after:3,after_sample:3});
  expect(result.report.import_rows).toBe(1);expect(result.validated).toBe(1);
}, 40_000);


test.skipIf(!clickhouseBinary())("F-1 child rollout stores its native id and a parent alias in real ClickHouse", async () => {
  const { dryRun } = await import("../../src/archaeology/pipeline");
  const { parseLine } = await import("../../src/ship/parse");
  const { applySchema } = await import("../../src/lib/schema");
  const bytes=Buffer.from('{"type":"session_meta","payload":{"id":"child","session_id":"parent"}}\n{"type":"event_msg","payload":{"type":"fixture"}}\n');
  const row: Inventory={machine:"m4",source_kind:"archive_dir",container:"",member_path:"rollout-child.jsonl",session_id:"child",harness:"codex",bytes:String(bytes.length),lines:"2",first_ts:"2026-01-01",last_ts:"2026-01-01",cwd:"/Users/etanheyman/Gits/example",sha256:sha256(bytes),mtime:""};
  const report=await dryRun(manifest([row],[]),{read:async()=>(async function*(){yield bytes;})()});
  const local=await startLocalClickHouse();
  try {
    await applySchema(local.client);
    await local.client.insert("session_events",report.sample);
    expect(await local.client.queryJSON("SELECT session_id FROM tokenlayer.session_events FINAL ORDER BY byte_offset")).toEqual([{session_id:"child"},{session_id:"child"}]);
    expect(await local.client.queryJSON("SELECT session_id,session_alias FROM tokenlayer.session_events FINAL WHERE session_alias != ''")).toEqual([{session_id:"child",session_alias:"parent"}]);
    expect(report.sample[0]).toMatchObject({...parseLine(bytes.toString().split("\n")[0]),raw:bytes.toString().split("\n")[0]+"\n"});
  } finally { await local.stop(); }
},40_000);
