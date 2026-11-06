import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { buildMemberPin } from "../../src/metadata/build-member-pin";
import { hash, RECORD_CAP } from "../../src/metadata/stream";
import { project } from "../../src/metadata/run";
const raw = '{"type":"session_meta","payload":{"id":"synthetic"}}\n';
function fixture(text = raw) {
  const dir = mkdtempSync(join(tmpdir(), "member-pin-")), path = join(dir, "synthetic.jsonl.zst");
  const z = Bun.spawnSync(["zstd", "-q", "-c"], { stdin: Buffer.from(text), maxBuffer: 64 * 1024 ** 2 });
  expect(z.exitCode).toBe(0); writeFileSync(path, z.stdout);
  const s = statSync(path), physicalIdentity = { dev:s.dev, ino:s.ino, size:s.size, mtimeMs:s.mtimeMs, ctimeMs:s.ctimeMs };
  const identity = { provider:"codex", custodyMachine:"synthetic", originMachine:"UNKNOWN", originProof:"UNKNOWN",
    containerDriveId:"UNKNOWN", containerHash:"UNKNOWN", memberPath:"synthetic.jsonl",
    memberHash:hash(text), physicalRepresentationHash:hash(z.stdout) };
  const coordinates = { firstLFLine:1, decodedOffset:0, decodedBytes:Buffer.byteLength(text),
    records: text.split("\n").length - 1 + (text.endsWith("\n") ? 0 : 1) };
  const receipt = { version:1, kind:"tokenlayer-member-admission", scope:"synthetic-only", admission:"synthetic",
    identity, physicalIdentity, coordinates };
  const admissionReceiptPath = join(dir,"admission.json");
  const m = { version:1, scope:receipt.scope, admission:"synthetic", sourcePath:path, identity,
    physicalIdentity, coordinates, admissionReceiptPath, admissionReceiptSha256:"",
    limits:{ compressedBytes:z.stdout.length, decodedBytes:Buffer.byteLength(text), ratio:1_000_000,
      rows:1000, millis:10000, outputBytes:Buffer.byteLength(text)+1024*1024 } };
  const manifest = join(dir,"input.json"), out = join(dir,"out");
  const save = () => { const bytes=JSON.stringify(receipt); writeFileSync(admissionReceiptPath,bytes);
    m.admissionReceiptSha256=hash(bytes); writeFileSync(manifest,JSON.stringify(m)); };
  save(); return { dir, path, m, receipt, save, manifest, out };
}
async function reject(f:ReturnType<typeof fixture>, code:string) {
  await expect(buildMemberPin(f.manifest,f.out)).rejects.toThrow(code);
  expect(existsSync(join(f.out,"manifest.json"))).toBe(false);
}
test("real zstd pins exact LF bytes, identity sidecar and partial projector roundtrip", async () => {
  const f=fixture(raw+JSON.stringify({type:"compacted",body:"x".repeat(RECORD_CAP+8)})+"\n"+raw);
  const r=await buildMemberPin(f.manifest,f.out);
  expect(r.status).toBe("PIN_BUILT_SYNTHETIC_ONLY"); expect(r.rawHistoryAcceptance).toBe("HOLD");
  const manifest=JSON.parse(readFileSync(join(f.out,"manifest.json"),"utf8"));
  expect(manifest).toEqual(r); expect(r.decoder).toEqual({command:"zstd -dc -q",exit:0});
  const p=JSON.parse(readFileSync(join(f.out,"manifest.json"),"utf8")), source=p.sources[0];
  expect(hash(readFileSync(source.path))).toBe(source.memberHash);
  expect(hash(readFileSync(source.coordinatesPath))).toBe(source.coordinatesSha256);
  const coordinates=readFileSync(source.coordinatesPath,"utf8").trim().split("\n").map(x=>JSON.parse(x));
  expect(coordinates.map(x=>x.originalLFLine)).toEqual([1,2,3]);
  expect(coordinates[1].recordBytes).toBeGreaterThan(RECORD_CAP);
  expect(coordinates[2].decodedOffset).toBe(coordinates[0].recordBytes+coordinates[1].recordBytes);
  expect(statSync(f.out).mode&0o777).toBe(0o700); expect(statSync(source.path).mode&0o777).toBe(0o600);
  const projected=await project(join(f.out,"manifest.json"),join(f.dir,"projected"));
  expect(projected.consumption).toBe("PARTIAL_METADATA_ONLY"); expect(projected.uninspected).toBe(1);
});
test("synthetic complete metadata roundtrip preserves synthetic admission", async () => {
  const f=fixture(); f.m.identity.originMachine="synthetic"; f.m.identity.originProof="synthetic";
  f.m.identity.containerDriveId="NOT_APPLICABLE"; f.m.identity.containerHash="NOT_APPLICABLE"; f.save();
  await buildMemberPin(f.manifest,f.out);
  const p=await project(join(f.out,"manifest.json"),join(f.dir,"projected"));
  expect(p.consumption).toBe("SCOPED_METADATA"); expect(p.sources[0].admission).toBe("synthetic");
});
for (const mode of ["corrupt","truncated","trailing"] as const) test(`real zstd rejects ${mode} with redacted diagnostics`,async()=>{
  const f=fixture(), b=readFileSync(f.path);
  writeFileSync(f.path,mode==="corrupt"?Buffer.from("SECRET_DECODER_INPUT"):mode==="truncated"?b.subarray(0,b.length-2):Buffer.concat([b,Buffer.from("SECRET_TRAILING")]));
  const s=statSync(f.path); Object.assign(f.m.physicalIdentity,{size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});
  f.m.identity.physicalRepresentationHash=hash(readFileSync(f.path)); f.m.limits.compressedBytes=s.size; f.save();
  await reject(f,"MEMBER_DECODE_FAILED");
  const p=Bun.spawnSync(["bun",resolve("src/metadata/build-member-pin.ts"),f.manifest,f.out+"cli"]);
  expect(p.exitCode).toBe(1);expect(p.stderr.toString()).toBe("REJECTED:MEMBER_DECODE_FAILED\n");
  expect(p.stdout.toString()).toBe("");
});
for (const cap of ["compressedBytes","decodedBytes","ratio","rows","millis","outputBytes"] as const)
  test(`real decoder hard ${cap} cap has no completion`,async()=>{
    const f=fixture(raw.repeat(10000)); f.m.limits.rows=20000;
    f.m.limits[cap]=cap==="ratio"?0.01:1; f.save();
    await reject(f,cap==="outputBytes"?"MEMBER_OUTPUT_CAP":cap==="millis"?"MEMBER_TIME_CAP":`MEMBER_${cap.toUpperCase()}_CAP`);
  });
test("wrong physical/decoded pins, admission pins, identity and coordinates fail closed",async()=>{
  for(const mode of ["physical","decoded","receipt","identity","coordinates","admission"]) {
    const f=fixture();
    if(mode==="physical") f.m.identity.physicalRepresentationHash="a".repeat(64);
    if(mode==="decoded") f.m.identity.memberHash="a".repeat(64);
    if(mode==="identity") f.receipt.identity={...f.m.identity,memberPath:"other"};
    if(mode==="coordinates") f.receipt.coordinates={...f.m.coordinates,records:2};
    if(mode==="admission") f.m.admission="admitted";
    f.save(); if(mode==="receipt") {f.m.admissionReceiptSha256="a".repeat(64);writeFileSync(f.manifest,JSON.stringify(f.m));}
    await reject(f,mode==="physical"?"MEMBER_PHYSICAL_PIN":mode==="decoded"?"MEMBER_DECODED_PIN":"MEMBER_ADMISSION_INVALID");
  }
});
test("terminal non-LF is explicitly invalid, never completion",async()=>{const f=fixture(raw.trimEnd());await reject(f,"MEMBER_TERMINAL_NON_LF");});
test("physical preflight reserves 20GiB plus pending and the full output cap",async()=>{
  const f=fixture();f.m.limits.outputBytes=128*1024**3;f.save();
  await reject(f,"MEMBER_PREFLIGHT_SPACE");expect(existsSync(f.out)).toBe(false);
});
test("wall timeout interrupts a real active zstd decode with provisional bytes",async()=>{
  const f=fixture(raw.repeat(100000));Object.assign(f.m.limits,{rows:100000,millis:200,outputBytes:64*1024**2});f.save();
  await reject(f,"MEMBER_TIME_CAP");expect(statSync(join(f.out,"decoded.ndjson")).size).toBeGreaterThan(0);
});
test("receipt is mandatory, bounded and nofollow; invalid limits never publish",async()=>{
  for(const mode of ["missing","oversize","symlink","limit"]){
    const f=fixture();
    if(mode==="limit") f.m.limits.rows=0;
    f.save();
    if(mode==="missing") {f.m.admissionReceiptSha256="";writeFileSync(f.manifest,JSON.stringify(f.m));}
    if(mode==="oversize") writeFileSync(f.m.admissionReceiptPath,"x".repeat(RECORD_CAP+1));
    if(mode==="symlink") {const p=f.m.admissionReceiptPath;renameSync(p,p+"saved");symlinkSync(p+"saved",p);}
    await reject(f,mode==="missing"?"MEMBER_SPEC_INVALID":mode==="limit"?"MEMBER_LIMIT_INVALID":mode==="oversize"?"MEMBER_DOCUMENT_INVALID":"MEMBER_IO_INVALID");
  }
});
test("receipt coordinates bind actual decoded records and bytes; unknown fields are not republished",async()=>{
  for(const key of ["records","decodedBytes"] as const) {
    const f=fixture();f.m.coordinates[key]++;f.save();await reject(f,"MEMBER_COORDINATES_INVALID");
  }
  const f=fixture();Object.assign(f.m.identity,{secret:"BODY_NOT_FOR_OUTPUT"});f.save();
  const r=await buildMemberPin(f.manifest,f.out);expect(JSON.stringify(r)).not.toContain("BODY_NOT_FOR_OUTPUT");
});
test("nofollow, fresh output and repository ignore guards",async()=>{
  const f=fixture(); const link=join(f.dir,"alias");symlinkSync(f.path,link); f.m.sourcePath=link;f.save();
  await reject(f,"MEMBER_IO_INVALID");
  const g=fixture(); await expect(buildMemberPin(g.manifest,resolve("src/member-denied"))).rejects.toThrow("OUTPUT_NOT_IGNORED");
  expect(existsSync(resolve("src/member-denied"))).toBe(false);
  await buildMemberPin(g.manifest,g.out); await expect(buildMemberPin(g.manifest,g.out)).rejects.toThrow();
});
test("CLI source swap and SIGKILL leave no completion",async()=>{
  for(const mode of ["swap","kill"]) {
    const text=JSON.stringify({body:randomBytes(4*1024*1024).toString("hex")})+"\n", f=fixture(text);
    const p=Bun.spawn(["bun",resolve("src/metadata/build-member-pin.ts"),f.manifest,f.out],{stdout:"pipe",stderr:"pipe"});
    try {
      const deadline=Date.now()+5000;
      while(!existsSync(join(f.out,"decoded.ndjson")) && p.exitCode===null && Date.now()<deadline) await Bun.sleep(1);
      expect(p.exitCode).toBeNull(); p.kill("SIGSTOP");
      if(mode==="kill") p.kill("SIGKILL");
      else {renameSync(f.path,f.path+".saved");writeFileSync(f.path,"replacement");p.kill("SIGCONT");}
      await p.exited; const err=await new Response(p.stderr).text();
      expect(err).not.toContain(f.path); expect(existsSync(join(f.out,"manifest.json"))).toBe(false);
      if(mode==="swap") {expect(p.exitCode).toBe(1);expect(err).toContain("MEMBER_SOURCE_UNSTABLE");}
    } finally {if(p.exitCode===null){p.kill("SIGKILL");await p.exited;}}
  }
},15000);
