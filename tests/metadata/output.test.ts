import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Budget, FLOOR_BYTES, PENDING_BYTES, physicalFree } from "../../src/metadata/output";
import { project } from "../../src/metadata/run";
import { hash } from "../../src/metadata/stream";
import { Database } from "bun:sqlite";
function input(rows=1, limits: Record<string,unknown>={}) {
  const dir=mkdtempSync(join(tmpdir(),"metadata-output-")), path=join(dir,"input");
  const raw=Array.from({length:rows},(_,i)=>JSON.stringify({type:"session_meta",payload:{id:`s-${i}`}})+"\n").join("");
  writeFileSync(path,raw);
  const source={path,inputSha256:hash(raw),memberHash:hash(raw),physicalRepresentationHash:hash(raw),
    provider:"codex",format:"raw",admission:"synthetic",custodyMachine:"test",originMachine:"test",
    originProof:"synthetic",containerDriveId:"NOT_APPLICABLE",containerHash:"NOT_APPLICABLE",memberPath:"synthetic"};
  const manifest=join(dir,"input.json");
  const save=(sources=[source])=>writeFileSync(manifest,JSON.stringify({version:1,scope:"synthetic",sources,...limits}));
  save(); return {dir,path,source,manifest,save,out:join(dir,"out")};
}
test("space checks reserve 20GiB of physical blocks and bounded pending bytes on every write", () => {
  let free=FLOOR_BYTES+1024**3;
  const b=new Budget(tmpdir(),2,()=>free);
  free=FLOOR_BYTES+PENDING_BYTES+1000;
  b.check(1000);
  free=FLOOR_BYTES+PENDING_BYTES+999;
  expect(()=>b.check(1000)).toThrow("PHYSICAL_SPACE_FLOOR");
  expect(physicalFree(tmpdir())).toBeGreaterThan(FLOOR_BYTES);
});
test("preflight reserves the complete bounded output plus scratch budget", () => {
  expect(()=>new Budget(tmpdir(),10000,()=>FLOOR_BYTES+PENDING_BYTES+1024)).toThrow("PREFLIGHT_SPACE_BUDGET");
});
test("row cap and actual byte cap abort without consumable partial output", async () => {
  const r=input(2,{maxOutputRows:1});
  const result=await project(r.manifest,r.out);
  expect(result.status).toBe("INVALID_NON_CONSUMABLE"); expect(result.consumption).toBe("NONE");
  expect(result.errors).toContain("OUTPUT_ROW_CAP");
  const b=new Budget(tmpdir(),1,()=>FLOOR_BYTES+1024**3);
  expect(()=>b.account(1024**3)).toThrow("OUTPUT_BYTES_BUDGET");
});
test("scratch candidate index commits bounded transactions; final manifest is atomic", async () => {
  const r=input(600), result=await project(r.manifest,r.out);
  expect(result.scratch).toMatchObject({synchronous:"OFF",batchRows:256,committedBatches:3});
  const db=new Database(join(r.out,"candidate-index.sqlite"),{readonly:true});
  try { expect(db.query("SELECT count(*) AS n FROM refs").get()).toEqual({n:600}); } finally { db.close(); }
  expect(readdirSync(r.out)).not.toContain("manifest.json.pending");
  expect(JSON.parse(readFileSync(join(r.out,"manifest.json"),"utf8")).consumption).toBe("SCOPED_METADATA");
  expect(result.outputs.metadataSha256).toBe(hash(readFileSync(join(r.out,"metadata.ndjson"))));
});
test("coordinate count and pin corruption never qualify for partial consumption", async () => {
  for (const mode of ["count","pin"]) {
    const r=input(), coordinatesPath=join(r.dir,"coordinates");
    const raw=readFileSync(r.path), row={originalLFLine:1,decodedOffset:0,recordHash:hash(raw),recordBytes:raw.length};
    const text=JSON.stringify(row)+"\n"+(mode==="count"?JSON.stringify({...row,originalLFLine:2,decodedOffset:raw.length})+"\n":"");
    writeFileSync(coordinatesPath,text);
    r.save([{...r.source,coordinatesPath,coordinatesSha256:mode==="pin"?"a".repeat(64):hash(text)} as any]);
    const result=await project(r.manifest,r.out);
    expect(result.status).toBe("INVALID_NON_CONSUMABLE"); expect(result.consumption).toBe("NONE");
  }
});
test("duplicate upstream gap coordinates reject setup", async () => {
  const r=input(), gap={line:3,bytes:50,sha256:"a".repeat(64)};
  r.save([{...r.source,upstreamUninspected:[gap,gap]} as any]);
  await expect(project(r.manifest,r.out)).rejects.toThrow("OMISSION_RECEIPT_INVALID");
});
test("unsafe repository outputs and symlink aliases are rejected before writing", async () => {
  const r=input(), parent=join(r.dir,"alias"); symlinkSync(resolve("src"),parent);
  for(const out of [resolve("src",`metadata-denied-${Date.now()}`),join(parent,"denied")]) {
    await expect(project(r.manifest,out)).rejects.toThrow(); expect(existsSync(out)).toBe(false);
  }
});
test("unreadable input is a non-consumable error and CLI setup errors use safe reason codes", async () => {
  const r=input(); r.save([{...r.source,path:join(r.dir,"missing")}]);
  const result=await project(r.manifest,r.out);
  expect(result.consumption).toBe("NONE"); expect(result.errors).toContain("INPUT_OR_PARENT_MISSING");
  const bad=join(r.dir,"malformed"); writeFileSync(bad,"SECRET_NOT_JSON");
  const p=Bun.spawnSync(["bun",resolve("src/metadata/main.ts"),bad,join(r.dir,"other")]);
  expect(p.exitCode).toBe(1); expect(p.stderr.toString()).toContain("MANIFEST_INVALID");
  expect(p.stderr.toString()).not.toContain("SECRET_NOT_JSON");
});
test("a killed real CLI leaves no final manifest; rows alone never authorize consumption", async () => {
  const r=input(50000,{maxOutputRows:50000});
  const child=Bun.spawn(["bun",resolve("src/metadata/main.ts"),r.manifest,r.out],{stdout:"pipe",stderr:"pipe"});
  const deadline=Date.now()+3000;
  try {
    while (!existsSync(join(r.out,"metadata.ndjson")) && child.exitCode===null && Date.now()<deadline) await Bun.sleep(2);
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL"); await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(existsSync(join(r.out,"manifest.json"))).toBe(false);
  } finally { if(child.exitCode===null) { child.kill("SIGKILL"); await child.exited; } }
},5000);
