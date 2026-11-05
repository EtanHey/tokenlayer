import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { project } from "../../src/metadata/run";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function run(rows: unknown[], options: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "metadata-test-"));
  const raw = rows.map(x => JSON.stringify(x) + "\n").join("");
  const input = join(dir, "input.ndjson"); writeFileSync(input, raw);
  const source = { path: input, inputSha256: sha(raw), format: "raw", provider: "codex",
    admission: "synthetic", custodyMachine: "test", originMachine: "UNKNOWN", originProof: "UNKNOWN",
    containerDriveId: "UNKNOWN", containerHash: "UNKNOWN", memberPath: "synthetic.jsonl",
    memberHash: sha(raw), physicalRepresentationHash: sha(raw), ...options };
  const manifest = join(dir, "input.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, scope: "synthetic-only", sources: [source] }));
  const out = join(dir, "out");
  const receipt = await project(manifest, out);
  return { receipt, out, manifest, source, rows: readFileSync(join(out, "metadata.ndjson"), "utf8").trim().split("\n").map(x=>JSON.parse(x)) };
}
const header = {type:"session_meta", timestamp:"birth", payload:{id:"child", forked_from_id:"parent", timestamp:"native-birth", cwd:"/synthetic"}};
test("first owner is immutable across copied parent header; independent clocks and refs survive", async () => {
  const r = await run([header, { ...header, payload:{id:"parent",timestamp:"old"}},
    {type:"event_msg", timestamp:"new", payload:{type:"task_started",turn_id:"task"}},
    {type:"event_msg", payload:{type:"token_count", info:{last_token_usage:{output_tokens:4,reasoning_output_tokens:2},total_token_usage:null}, response_id:"response"}}]);
  expect(r.rows.map(x=>x.context.owner.id.value)).toEqual(["child","child","child","child"]);
  expect(r.rows[1].embeddedHeader.id.value).toBe("parent");
  expect(r.rows[3].context.task.value).toBe("task");
  expect(r.rows[3].context.owner.forkParent.value).toBe("parent");
  expect(r.rows[3].context.owner.birth.value).toBe("native-birth");
  expect(r.rows[3].refs.response_id.value).toBe("response");
  expect(r.rows[3].usage.last_token_usage.value).toEqual({output_tokens:4,reasoning_output_tokens:2});
  expect(r.rows[3].usage.total_token_usage.presence).toBe("null");
  expect(r.rows[3].basis).toBe("UNKNOWN");
});
test("raw absent, null, and zero are distinct recursively; no fabricated null refs or body", async () => {
  const r = await run([header, {type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:0,output_tokens:null}}},body:"PRIVATE_BODY"}]);
  const row = r.rows[1];
  expect(row.usage.last_token_usage.fields.input_tokens.presence).toBe("zero");
  expect(row.usage.last_token_usage.fields.output_tokens.presence).toBe("null");
  expect(row.usage.last_token_usage.fields.cached_input_tokens.presence).toBe("absent");
  expect(row.usage.total_token_usage.presence).toBe("absent");
  expect(row.refs.response_id).toEqual({presence:"absent"});
  expect(JSON.stringify(r.rows)).not.toContain("PRIVATE_BODY");
});
test("Claude native TTL components remain disjoint without arithmetic or inferred TTL", async () => {
  const usage = {cache_creation_input_tokens:11,cache_creation:{ephemeral_5m_input_tokens:7,ephemeral_1h_input_tokens:4},output_tokens:9};
  const r=await run([{type:"assistant",sessionId:"c",requestId:"req",message:{id:"msg",usage,content:[{text:"SECRET"}]}}],{provider:"claude"});
  expect(r.rows[0].usage.claude_usage.value).toEqual(usage);
  expect(r.rows[0].usage.claude_usage.fields.cache_creation.fields.ephemeral_5m_input_tokens.presence).toBe("value");
  expect(JSON.stringify(r.rows)).not.toContain("SECRET");
});
test("11-13MB lines are hashed UNINSPECTED; scan resumes with exact LF offsets and bounded retention", async () => {
  const huge = {type:"compacted",body:"x".repeat(13*1024*1024)};
  const r=await run([header, huge, {type:"event_msg",payload:{type:"task_started",turn_id:"after"}}]);
  expect(r.rows[1].status).toBe("UNINSPECTED_OVERSIZE");
  expect(r.rows[1].coordinate.recordHash).toBe(sha(JSON.stringify(huge)+"\n"));
  expect(r.rows[2].coordinate.decodedOffset).toBe(Buffer.byteLength(JSON.stringify(header)+"\n"+JSON.stringify(huge)+"\n"));
  expect(r.rows[2].context.task.value).toBe("after");
  expect(r.receipt.complete).toBe(false);
  expect(r.receipt.peakRetainedRecordBytes).toBeLessThanOrEqual(1024*1024);
});
test("missing scope/pins fails closed; private fresh outputs and pin mismatch stay incomplete", async () => {
  const r=await run([header]);
  expect(statSync(r.out).mode & 0o777).toBe(0o700);
  expect(statSync(join(r.out,"metadata.ndjson")).mode & 0o777).toBe(0o600);
  await expect(project(r.manifest,r.out)).rejects.toThrow();
  writeFileSync(r.manifest,JSON.stringify({version:1,sources:[r.source]}));
  await expect(project(r.manifest,r.out+"2")).rejects.toThrow();
  writeFileSync(r.manifest,JSON.stringify({version:1,scope:"x",sources:[r.source]}));
  writeFileSync(r.source.path, "changed input\n");
  const bad=await project(r.manifest,r.out+"3");
  expect(bad.complete).toBe(false);
  expect(bad.status).toBe("INVALID_NON_CONSUMABLE");
  expect(bad.consumption).toBe("NONE");
});
test("same stable refs produce candidates but never subtract usage or union owners", async () => {
  const row={type:"event_msg",payload:{type:"token_count",response_id:"same",info:{last_token_usage:{output_tokens:4}}}};
  const r=await run([header,row,row]);
  const candidates=readFileSync(join(r.out,"candidates.ndjson"),"utf8").trim().split("\n").map(x=>JSON.parse(x));
  expect(candidates.length).toBe(1);
  expect(r.rows).toHaveLength(3);
  expect(r.rows[1].usage).toEqual(r.rows[2].usage);
});
test("admitted raw subset joins pinned original coordinates instead of export ordinals", async () => {
  const r=await run([header]);
  const coordinatesPath=join(r.out,"coordinates.ndjson");
  const raw=readFileSync(r.source.path);
  const mapping=JSON.stringify({originalLFLine:17,decodedOffset:1234,recordHash:sha(raw.toString()),recordBytes:raw.length})+"\n";
  writeFileSync(coordinatesPath,mapping);
  writeFileSync(r.manifest,JSON.stringify({version:1,scope:"admitted-subset",sources:[{...r.source,
    physicalRepresentationHash:"a".repeat(64),memberHash:"b".repeat(64),coordinatesPath,coordinatesSha256:sha(mapping)}]}));
  await project(r.manifest,r.out+"mapped");
  const row=JSON.parse(readFileSync(join(r.out+"mapped","metadata.ndjson"),"utf8"));
  expect(row.coordinate.originalLFLine).toBe(17);
  expect(row.coordinate.outputOrdinal).toBe(1);
  expect(row.coordinate.decodedOffset).toBe(1234);
  expect(row.context.owner.status).toBe("UNKNOWN");
});
test("unsupported usage content stays hash-only and prevents scoped completion", async () => {
  const r=await run([header,{type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{body:"DO_NOT_EXPORT"}}}}],{
    originMachine:"synthetic",originProof:"synthetic",containerDriveId:"NOT_APPLICABLE",containerHash:"NOT_APPLICABLE"});
  expect(r.rows[1].usage.last_token_usage.presence).toBe("UNRESOLVED");
  expect(JSON.stringify(r.rows)).not.toContain("DO_NOT_EXPORT");
  expect(r.receipt.complete).toBe(false);
});

test("witness continuity changes before projecting the first row after an upstream gap", async () => {
  const r = await run([{type:"session_meta",line:1,declared_session:"c"},
    {type:"event_msg",line:4,event:"token_count"}, {type:"event_msg",line:8,event:"token_count"}],
    {format:"witness",admission:"witness",witnessReceiptHash:"a".repeat(64),
      upstreamUninspected:[{line:6,bytes:13000000,sha256:"b".repeat(64)}]});
  expect(r.rows.slice(0,3).map(x=>x.context.continuity)).toEqual([
    "OBSERVED","OBSERVED","UNKNOWN_AFTER_UNINSPECTED_RECORD"]);
});
test("Claude first actual session record owns with an explicit coordinate basis and realistic usage", async () => {
  const usage={input_tokens:0,output_tokens:8,cache_read_input_tokens:null,cache_creation_input_tokens:11,
    cache_creation:{ephemeral_5m_input_tokens:7,ephemeral_1h_input_tokens:4},
    service_tier:"standard",server_tool_use:{web_search_requests:0,web_fetch_requests:2}};
  const r=await run([{type:"summary"},{type:"assistant",sessionId:"c",message:{usage}},
    {type:"assistant",sessionId:"copied",message:{usage:{output_tokens:1}}}],{provider:"claude"});
  expect(r.rows[0].context.owner.status).toBe("UNKNOWN");
  expect(r.rows[1].context.owner).toMatchObject({id:{value:"c"},basis:"first_session_record",coordinate:{originalLFLine:2}});
  expect(r.rows[2].context.owner.id.value).toBe("c");
  const u=r.rows[1].usage.claude_usage;
  expect(u.value).toEqual(usage);
  expect(u.fields.service_tier).toEqual({presence:"value",value:"standard"});
  expect(u.fields.input_tokens.presence).toBe("zero");
  expect(u.fields.cache_read_input_tokens.presence).toBe("null");
  expect(u.fields.total_tokens.presence).toBe("absent");
  expect(u.fields.cache_creation.fields.ephemeral_5m_input_tokens.value).toBe(7);
  expect(u.fields.cache_creation.fields.ephemeral_1h_input_tokens.value).toBe(4);
});
test("derived response context does not inflate stable candidates on non-usage rows", async () => {
  const r=await run([header,{type:"response_item",payload:{type:"function_call",id:"call"}},
    {type:"event_msg",payload:{type:"notice"}},{type:"event_msg",payload:{type:"notice"}}]);
  expect(r.rows[3].responseRef.value).toBe("call");
  expect(r.receipt.candidates).toBe(0);
});
test("mapped coordinates fail closed on duplicates, reversal, overlap, impossible offset and invalid hashes/lengths", async () => {
  const r=await run([header,header]);
  const raw=JSON.stringify(header)+"\n", bytes=Buffer.byteLength(raw);
  const a={originalLFLine:1,decodedOffset:0,recordHash:sha(raw),recordBytes:bytes};
  const b={...a,originalLFLine:2,decodedOffset:bytes};
  const cases=[[a,{...b,originalLFLine:1}], [b,a], [a,{...b,decodedOffset:bytes-1}],
    [a,{...b,decodedOffset:bytes+1}], [{...a,decodedOffset:1},b],
    [a,{...b,recordHash:"abc"}], [a,{...b,recordBytes:bytes+1}]];
  for (const [i,mapping] of cases.entries()) {
    const path=join(r.out,`coordinates-${i}`), text=mapping.map(x=>JSON.stringify(x)+"\n").join("");
    writeFileSync(path,text);
    writeFileSync(r.manifest,JSON.stringify({version:1,scope:"bad-map",sources:[{...r.source,
      coordinatesPath:path,coordinatesSha256:sha(text)}]}));
    const bad=await project(r.manifest,r.out+`bad-${i}`);
    expect(bad.complete).toBe(false);
    expect(bad.consumption).toBe("NONE");
  }
});
test("native usage scalar service tier retains numeric counter objects", async () => {
  const usage={output_tokens:2,service_tier:"standard",server_tool_use:{web_search_requests:0}};
  const r=await run([{type:"assistant",sessionId:"c",message:{usage}}],{provider:"claude"});
  expect(r.rows[0].usage.claude_usage.value).toEqual(usage);
});
test("partial metadata carries row and member gaps with explicit unknown full-source continuity", async () => {
  const r=await run([header]);
  expect(r.receipt.consumption).toBe("PARTIAL_METADATA_ONLY");
  expect(r.rows[0].gaps).toContain("originMachine");
  expect(r.rows[0].fullSourceContinuity).toBe("UNKNOWN");
  expect(r.receipt.sources[0].continuity).toBe("UNKNOWN");
  expect(r.receipt.sources[0].gapCoordinates).toBe("metadata.ndjson:coordinate");
});
test("a valid mapped subset with skipped original LF lines is partial with unknown continuity", async () => {
  const r=await run([header,header],{originMachine:"test",originProof:"synthetic",containerDriveId:"NOT_APPLICABLE",containerHash:"NOT_APPLICABLE"});
  const raw=JSON.stringify(header)+"\n", coordinatesPath=join(r.out,"gap-coordinates");
  const text=[{originalLFLine:1,decodedOffset:0},{originalLFLine:3,decodedOffset:Buffer.byteLength(raw)+2}]
    .map(x=>JSON.stringify({...x,recordHash:sha(raw),recordBytes:Buffer.byteLength(raw)})+"\n").join("");
  writeFileSync(coordinatesPath,text);
  writeFileSync(r.manifest,JSON.stringify({version:1,scope:"subset-gap",sources:[{...r.source,coordinatesPath,coordinatesSha256:sha(text)}]}));
  const result=await project(r.manifest,r.out+"gap");
  expect(result.status).toBe("UNRESOLVED"); expect(result.consumption).toBe("PARTIAL_METADATA_ONLY");
});
