import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ClickHouse } from "../../src/lib/clickhouse";
import { listJsonl, shipOnce, type ShipOptions } from "../../src/ship/ship";
import { readZstd } from "../../src/ship/zst";
import { loadState } from "../../src/ship/state";

const scratch = join(import.meta.dir, "../../.local");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "zst-"));
const meta = Buffer.from(JSON.stringify({type:"session_meta",timestamp:"2026-10-29T00:00:00Z",payload:{id:"child",session_id:"parent",originator:"T3 Code",cwd:"/fixture/repo"}})+"\r\n");
const bytes = Buffer.concat([meta, Buffer.from([0xff, 10]), Buffer.from('\n{"type":"turn_context","payload":{"model":"fixture"}}\n')]);
const rows: Record<string, unknown>[] = [];
const logs: string[] = [];
const server = Bun.serve({port:0, async fetch(req) { for(const l of (await req.text()).split("\n")) if(l) rows.push(JSON.parse(l)); return new Response(""); }});
afterAll(() => server.stop(true));
function options(name: string): ShipOptions {
  const root = join(dir,name); mkdirSync(root);
  return {machine:"m4",roots:[{kind:"codex",dir:root}],statePath:join(dir,name+".state"),clickhouse:new ClickHouse({url:`http://127.0.0.1:${server.port}`,user:"default",password:"",database:"tokenlayer"}),rateBytesPerSec:0,batchBytes:64,log:m=>logs.push(m)};
}
function compressed(path:string, data=bytes) {writeFileSync(path,Bun.zstdCompressSync(data));}

test("missing zstd warns once per pass, preserves compressed checkpoints and keeps shipping plain files", async () => {
 const o = options("missing-decoder"), p = join(o.roots[0].dir, "old.jsonl");
 writeFileSync(p, bytes); await shipOnce(o);
 compressed(p + ".zst"); unlinkSync(p);
 compressed(join(o.roots[0].dir, "unseen.jsonl.zst"));
 const checkpoint = loadState(o.statePath).files[p];
 const journal = readFileSync(o.statePath + ".generations", "utf8");
 const plain = join(o.roots[0].dir, "plain.jsonl"); writeFileSync(plain, "{}\n");
 const script = `
  import { shipOnce } from ${JSON.stringify(join(import.meta.dir, "../../src/ship/ship.ts"))};
  import { ClickHouse } from ${JSON.stringify(join(import.meta.dir, "../../src/lib/clickhouse.ts"))};
  const logs = [];
  const opts = ${JSON.stringify({ ...o, clickhouse: undefined, log: undefined })};
  opts.clickhouse = new ClickHouse(${JSON.stringify(o.clickhouse.config)});
  opts.log = msg => logs.push(msg);
  const first = await shipOnce(opts);
  const second = await shipOnce(opts);
  console.log(JSON.stringify({ first, second, logs }));
 `;
 // An isolated process exercises real PATH lookup without changing the test runner's environment.
 const proc = Bun.spawn([process.execPath, "--eval", script], {
  cwd: dir, env: { PATH: "" }, stdout: "pipe", stderr: "pipe",
 });
 const output = await new Response(proc.stdout).text(), error = await new Response(proc.stderr).text();
 expect(await proc.exited).toBe(0); expect(error).toBe("");
 const result = JSON.parse(output);
 expect(result.first.lines).toBe(1); expect(result.second.lines).toBe(0);
 expect(result.logs).toHaveLength(2);
 for (const warning of result.logs) {
  expect(warning).toMatch(/warning.*zstd.*PATH/);
  expect(warning.split("\n")).toHaveLength(1);
 }
 const state = loadState(o.statePath);
 expect(state.files[p]).toEqual(checkpoint);
 expect(state.files[join(o.roots[0].dir, "unseen.jsonl")]).toBeUndefined();
 expect(state.files[plain].offset).toBe(3);
 expect(loadState(o.statePath + ".generations").files[p]).toEqual(JSON.parse(journal).files[p]);
 expect(loadState(o.statePath + ".generations").files[join(o.roots[0].dir, "unseen.jsonl")]).toBeUndefined();
});

test("Codex discovery includes compressed rollouts",()=>{
 const o=options("discovery"); const p=join(o.roots[0].dir,"r.jsonl.zst");compressed(p);
 expect(listJsonl(o.roots[0].dir,true)).toEqual([p]);
});
test("zst raw bytes, decoded offsets, native session and harness; immutable checkpoint skips; changed content replays",async()=>{
 const o=options("immutable"),p=join(o.roots[0].dir,"r.jsonl.zst"),logical=p.slice(0,-4); compressed(p);
 const start=rows.length;const r=await shipOnce(o);expect(r.lines).toBe(3);expect(r.bytes).toBe(bytes.length);
 const shipped=rows.slice(start);expect(shipped.map(r=>r.path)).toEqual([logical,logical,logical]);
 expect(shipped.map(r=>r.byte_offset)).toEqual([0,meta.length,meta.length+3]);
 expect(shipped[0]).toMatchObject({session_id:"child",session_alias:"parent",harness:"t3",raw:meta.toString()});
 expect((await shipOnce(o)).lines).toBe(0);
 const saved=loadState(o.statePath).files[logical];expect(saved.compressed?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
 compressed(p,Buffer.concat([bytes,Buffer.from('{}\n')])); expect((await shipOnce(o)).lines).toBeGreaterThan(0);
});
test("plain legacy checkpoint and journal keep the same replacement keys after compression, checkpoint loss and materialization",async()=>{
 const o=options("transition"),p=join(o.roots[0].dir,"r.jsonl");writeFileSync(p,bytes);
 const start=rows.length;await shipOnce(o);const before=rows.slice(start);
 // This is the existing inode-based generation, not a generation invented by the compressed reader.
 const cp=loadState(o.statePath).files[p]; expect(cp.compressed).toBeUndefined();
 compressed(p+".zst");unlinkSync(p);unlinkSync(o.statePath);
 const compressedStart=rows.length;await shipOnce(o);const after=rows.slice(compressedStart);
 const key=(r:Record<string,unknown>)=>[r.path,r.generation,r.byte_offset,r.content_hash];
 expect(after.map(key)).toEqual(before.map(key));
 expect(loadState(o.statePath).files[p].generation).toBe(cp.generation);
 writeFileSync(p,Buffer.concat([bytes,Buffer.from('{}\n')]));unlinkSync(p+".zst");
 expect((await shipOnce(o)).lines).toBe(1);expect(rows.at(-1)?.generation).toBe(cp.generation);
});
test.each(["corrupt","truncated"])("%s zst is isolated, reports path/reason without content, and leaves no checkpoint",async(kind)=>{
 const o=options(kind),p=join(o.roots[0].dir,"bad.jsonl.zst");
 const packed=Bun.zstdCompressSync(Buffer.concat([bytes,Buffer.alloc(200000,120)]));
 writeFileSync(p,kind==="corrupt"?Buffer.from("SYNTHETIC_PRIVATE_CONTENT"):packed.subarray(0,packed.length-3));
 const start=rows.length;await expect(shipOnce(o)).rejects.toThrow();
 expect(rows.length).toBe(start);expect(loadState(o.statePath).files[p.slice(0,-4)]).toBeUndefined();
 expect(logs.at(-1)).toContain(p);expect(logs.at(-1)).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
});
test("backfill since uses compressed mtime and cap counts decoded bytes",async()=>{
 const o=options("since"),p=join(o.roots[0].dir,"r.jsonl.zst"); compressed(p);
 utimesSync(p,new Date(0),new Date(0));expect((await shipOnce({...o,sinceMs:1})).lines).toBe(0);
 const start=performance.now();const r=await shipOnce({...o,rateBytesPerSec:bytes.length*5});
 expect(r.bytes).toBe(bytes.length);expect(performance.now()-start).toBeGreaterThanOrEqual(170);
});

test("changed corrupt container preserves the last good checkpoint and recovers",async()=>{
 const o=options("recover"),p=join(o.roots[0].dir,"r.jsonl.zst"); compressed(p);await shipOnce(o);
 const before=JSON.stringify(loadState(o.statePath));
 writeFileSync(p,Bun.zstdCompressSync(bytes).subarray(0,15));
 await expect(shipOnce(o)).rejects.toThrow();expect(JSON.stringify(loadState(o.statePath))).toBe(before);
 compressed(p);expect((await shipOnce(o)).lines).toBe(3);
});
test("large decoded file yields bounded batches, skips decoded prefix and leaves unterminated tail",async()=>{
 const o=options("bounded"),p=join(o.roots[0].dir,"r.jsonl.zst");
 const line=Buffer.from('{"fixture":"'+"x".repeat(1000)+'"}\r\n');
 const count=20000; compressed(p,Buffer.concat([Buffer.from(line.toString().repeat(count)),Buffer.from('partial')]));
 let total=0,batches=0;
 for await(const b of readZstd(p,line.length,65536)) {
  expect(b.raw.length).toBeLessThanOrEqual(65536+256*1024);
  expect(b.lines[0].offset).toBe(line.length+total);
  total+=b.raw.length;batches++;
 }
 expect(total).toBe(line.length*(count-1));
 expect(batches).toBeGreaterThanOrEqual(Math.ceil(total/(65536+256*1024)));
});
