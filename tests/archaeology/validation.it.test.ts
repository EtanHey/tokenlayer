import { test, expect } from "bun:test";
import { startLocalClickHouse, clickhouseBinary } from "../../src/lib/local-clickhouse";
import { manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";

test.skipIf(!clickhouseBinary())("NIT-4 validatedDryRun completes with a real sample and isolates the baseline", async () => {
  const { validatedDryRun } = await import("../../src/archaeology/validation");
  const bytes = Buffer.from('{"sessionId":"happy-path","type":"user"}\n');
  const row: Inventory = { machine: "m4", source_kind: "archive_dir", container: "", member_path: "happy-path.jsonl", session_id: "happy-path", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const result = await validatedDryRun(manifest([row], []), { read: async () => (async function* () { yield bytes; })() }, 2);
  expect(result.validated).toBe(1);
  expect(result.report.import_rows).toBe(1);
  expect(result.report.sample[0].raw).toBe(bytes.toString());
  expect(result.baseline).toEqual({ seed_rows: 2, before: 2, after_sample: 2 });
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
}, 40_000);

test.skipIf(!clickhouseBinary())("NIT-4 sample validation writes only its sample table and rejects damaged raw", async () => {
  const bytes=Buffer.from('{"sessionId":"validation-fixture","type":"user"}\n');
  const row: Inventory={machine:"m4",source_kind:"archive_dir",container:"",member_path:"validation.jsonl",session_id:"validation-fixture",harness:"claude",bytes:String(bytes.length),lines:"1",first_ts:"2026-01-01",last_ts:"2026-01-01",cwd:"/Users/etanheyman/Gits/example",sha256:sha256(bytes),mtime:""};
  const { dryRun } = await import("../../src/archaeology/pipeline");
  const validation = await import("../../src/archaeology/validation");
  const { applySchema } = await import("../../src/lib/schema");
  const report=await dryRun(manifest([row],[]),{read:async()=>(async function*(){yield bytes;})()});
  const local=await startLocalClickHouse();
  try {
    await applySchema(local.client);
    const baseline="baseline\n";
    await local.client.insert("session_events",report.sample.map(r=>({...r,path:"validation://baseline",raw:baseline,content_hash:sha256(Buffer.from(baseline))})));
    expect(await validation.validateSample(local.client, report.sample)).toBe(1);
    expect(await local.client.queryJSON("SELECT raw,content_hash FROM tokenlayer.session_events FINAL")).toEqual([{raw:baseline,content_hash:sha256(Buffer.from(baseline))}]);
    await local.client.exec("DROP TABLE tokenlayer.archaeology_sample");
    await expect(validation.validateSample(local.client,report.sample.map(r=>({...r,raw:"damaged\n"})))).rejects.toThrow("raw/hash sample mismatch");
  } finally { await local.stop(); }
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

for (const signal of ["SIGINT", "SIGTERM"] as const) test.skipIf(!clickhouseBinary())(`NIT-6 validation child stops its ClickHouse on ${signal}`, async () => {
  const {mkdirSync,mkdtempSync,writeFileSync}=await import("node:fs");
  mkdirSync(".local",{recursive:true});
  const dir=mkdtempSync(`${process.cwd()}/.local/validation-signal-`),script=`${dir}/child.ts`;
  writeFileSync(script,`import {validatedDryRun} from ${JSON.stringify(`${process.cwd()}/src/archaeology/validation.ts`)};
    import {manifest} from ${JSON.stringify(`${process.cwd()}/src/archaeology/pipeline.ts`)};
    const row=${JSON.stringify({machine:"m4",source_kind:"archive_dir",container:"",member_path:"session.jsonl",session_id:"session",harness:"claude",bytes:"1",lines:"1",first_ts:"",last_ts:"",cwd:"/Users/etanheyman/Gits/example",sha256:"",mtime:""})};
    await validatedDryRun(manifest([row],[]),{read:async()=>{process.stdout.write("READING\\n");await new Promise(()=>{});return null;}});`);
  const child=Bun.spawn([process.execPath,script],{stdout:"pipe",stderr:"pipe",env:{...process.env,USER:"fixture"}});
  let server=0;
  try {
    const reader=child.stdout.getReader();
    let output="";
    while(!output.includes("READING")){const next=await reader.read();if(next.done)throw Error("validation child exited before reading");output+=new TextDecoder().decode(next.value);}
    const pids=Bun.spawnSync(["pgrep","-P",String(child.pid)]).stdout.toString().trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(1); server=pids[0]; expect(server).toBeGreaterThan(0);
    child.kill(signal); await child.exited;
    expect(()=>process.kill(server,0)).toThrow();
    expect(child.exitCode).toBe(signal==="SIGINT"?130:143);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    if(server)try{process.kill(server,"SIGKILL");}catch{}
  }
},40_000);
