import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ClickHouse } from "../../src/lib/clickhouse";
import { listJsonl, shipOnce, type ShipOptions } from "../../src/ship/ship";
import { compressedHash, spawnZstd, readZstd } from "../../src/ship/zst";
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

test("missing zstd warns once per process, preserves compressed checkpoints and keeps shipping plain files", async () => {
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
 expect(result.logs).toHaveLength(1);
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
 const start=rows.length; const error=await shipOnce(o).then(()=>null,e=>e);
 expect(error).toBeInstanceOf(AggregateError);
 expect(rows.length).toBe(start);expect(loadState(o.statePath).files[p.slice(0,-4)]).toBeUndefined();
 expect(error.errors[0].message).toContain(p);expect(error.errors[0].message).toContain("zstd decode failed");
 expect(error.errors[0].message).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
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
 compressed(p);expect((await shipOnce(o)).lines).toBe(0);
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


test("completed backfill idle pass neither reads zst nor spawns zstd", async () => {
 const o=options("idle"), p=join(o.roots[0].dir,"r.jsonl.zst"); compressed(p);
 let reads=0, spawns=0;
 const zstd = {
  fingerprint: async (path: string) => { reads++; return compressedHash(path); },
  spawn: (path: string) => { spawns++; return spawnZstd(path); },
 };
 await shipOnce({...o,zstd}); expect(reads).toBeGreaterThan(0); expect(spawns).toBeGreaterThan(0);
 reads=0; spawns=0;
 expect((await shipOnce({...o,zstd})).lines).toBe(0);
 expect(reads).toBe(0); expect(spawns).toBe(0);
});

test("verified 100-line prefix resumes with only 50 new rows and new-byte rate accounting", async () => {
 const o=options("resume"), p=join(o.roots[0].dir,"r.jsonl");
 const line=Buffer.from('{"fixture":true}\n');
 writeFileSync(p,Buffer.from(line.toString().repeat(100))); await shipOnce(o);
 compressed(p+".zst",Buffer.from(line.toString().repeat(150))); unlinkSync(p);
 const start=rows.length, r=await shipOnce(o);
 expect(r.lines).toBe(50); expect(rows.length-start).toBe(50); expect(r.bytes).toBe(line.length*50);
 expect(rows[start].byte_offset).toBe(line.length*100);
});

test("second decode cannot insert swapped unvalidated bytes", async () => {
 const o=options("swap"), p=join(o.roots[0].dir,"r.jsonl.zst"); compressed(p);
 let spawns=0;
 const zstd={spawn:(path:string)=>{
  if (++spawns===2) compressed(path,Buffer.from('{"swapped":true}\n'.repeat(100000)));
  return spawnZstd(path);
 }};
 const start=rows.length;
 await expect(shipOnce({...o,zstd})).rejects.toThrow();
 expect(spawns).toBe(2); expect(rows.length).toBe(start);
 expect(loadState(o.statePath).files[p.slice(0,-4)]?.offset ?? 0).toBe(0);
});

test("ClickHouse failures are labelled correctly and have one reporting path", async () => {
 const o=options("insert-error"), p=join(o.roots[0].dir,"r.jsonl.zst"); compressed(p);
 const messages:string[]=[];
 const unavailable=Bun.serve({port:0,fetch:()=>new Response("fixture database unavailable",{status:503})});
 try {
  o.clickhouse=new ClickHouse({...o.clickhouse.config,url:unavailable.url.href});
  const error=await shipOnce({...o,log:m=>messages.push(m)}).then(()=>null,e=>e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toHaveLength(1);
  expect(error.errors[0].message).toContain("clickhouse insert");
  expect(error.errors[0].message).not.toContain("zstd source failed");
  expect(messages).toHaveLength(0);
 } finally { unavailable.stop(true); }
});

test("ship daemon and deploy renderer include Homebrew in PATH", async () => {
 const { render }=await import("../../scripts/deploy/deploy");
 const template=readFileSync(join(import.meta.dir,"../../launchd/com.tokenlayer.ship.plist.template"),"utf8");
 const plist=render(template,{BUN:"/fixture/bun",REPO:"/fixture/repo",HOME:"/fixture/home",MACHINE:"m4"});
 expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
});


test("decoder copies chunks only linearly while building batches", async () => {
 const o=options("linear"),p=join(o.roots[0].dir,"r.jsonl.zst");
 const input=Buffer.from(('x'.repeat(1000)+'\n').repeat(20000)); compressed(p,input);
 const concat=Buffer.concat; let copied=0, total=0;
 const spy=spyOn(Buffer,"concat").mockImplementation((chunks,length)=>{
  copied+=length ?? chunks.reduce((n,b)=>n+b.length,0); return concat(chunks,length);
 });
 try { for await (const b of readZstd(p,0,4*1024*1024)) total+=b.raw.length; }
 finally { spy.mockRestore(); }
 expect(total).toBe(input.length); expect(copied).toBeLessThan(input.length*3);
});
