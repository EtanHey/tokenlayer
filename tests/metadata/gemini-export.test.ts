import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { geminiStatPin } from "../../src/metadata/gemini-json";
import { hash } from "../../src/metadata/stream";
import { GeminiOutput } from "../../src/metadata/gemini-output";
import { Budget, FLOOR_BYTES, PENDING_BYTES } from "../../src/metadata/output";
import { exportGeminiJson } from "../../src/metadata/gemini-export";
const message = '{"id":"same","type":"gemini","timestamp":null,"tokens":{"input":7,"output":0,"cached":null,"thoughts":9007199254740993,"total":1.20e1},"content":"BODY_CANARY 🦊","toolCalls":["TOOL_CANARY"],"KEY_CANARY":9}';
function fixture(raw = Buffer.from('{"sessionId":"synthetic","projectHash":"p","startTime":null,"prefix":"é","messages":[\r\n' + message + ',' + message + ']}')) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gemini-export-"))), path = join(dir,"chat.json"), manifest = join(dir,"input.json"), out = join(dir,"out");
  fs.writeFileSync(path,raw,{mode:0o600});
  const source = { path, provider:"gemini-cli", sourceFormat:"gemini-chat-json", coordinateKind:"json-utf8-span-v1", admission:"synthetic",
    custodyMachine:"synthetic-custody", originMachine:"UNKNOWN", originProof:"UNKNOWN", originalPath:"UNKNOWN",
    sourceRoot:dir, rootKind:"native-gemini-cli-tmp", documentBytes:raw.length, documentHash:hash(raw), stat:geminiStatPin(fs.lstatSync(path,{bigint:true})) };
  const spec:any = { version:1, kind:"tokenlayer-gemini-json-export-input", scope:"synthetic-only", maxOutputRows:2, expectedMessages:2, expectedSessionId:"synthetic", source };
  const save = () => fs.writeFileSync(manifest,JSON.stringify(spec),{mode:0o600}); save();
  return { dir,path,manifest,out,raw,source,spec,save, clean:()=>fs.rmSync(dir,{recursive:true,force:true}) };
}
const cli = (f:ReturnType<typeof fixture>) => Bun.spawnSync(["bun",resolve("src/metadata/gemini-main.ts"),f.manifest,f.out]);
test("real CLI exports exact UTF8 spans and six counter states, private atomic hashes and HOLD", () => {
  const f=fixture(); try {
    const p=cli(f); expect(p.exitCode).toBe(2); expect(p.stderr.toString()).toBe("");
    const r=JSON.parse(fs.readFileSync(join(f.out,"manifest.json"),"utf8"));
    expect(r).toMatchObject({version:1,kind:"tokenlayer-gemini-json-metadata",status:"UNRESOLVED",complete:false,exportComplete:true,consumption:"PARTIAL_METADATA_ONLY",rawHistoryAcceptance:"HOLD",records:2});
    const bytes=fs.readFileSync(join(f.out,"metadata.ndjson")), rows=bytes.toString().trim().split("\n").map(x=>JSON.parse(x));
    expect(r.outputs.metadataSha256).toBe(hash(bytes)); expect(r.outputs.metadataBytes).toBe(bytes.length);
    let at=0; for(const row of rows) {
      const start=f.raw.indexOf(Buffer.from(message),at); at=start+Buffer.byteLength(message);
      expect(row.coordinate).toMatchObject({documentHash:hash(f.raw),utf8ByteStart:start,utf8ByteEndExclusive:at,spanSha256:hash(message),originalLFLine:"NOT_APPLICABLE"});
      expect(Object.fromEntries(Object.entries(row.nativeGeminiTokens.fields).map(([k,v]:any)=>[k,v.presence]))).toEqual({input:"value",output:"zero",cached:"null",thoughts:"UNRESOLVED",tool:"absent",total:"value"});
      expect(row.nativeGeminiTokens.fields.total.value).toBe(12); expect(row.upstreamPresence).toBe("UNKNOWN");
      expect(row.gaps).toContain("originMachine"); expect(row.gaps).toContain("UNSUPPORTED_METADATA_VALUE");
    }
    expect(rows.map(x=>x.coordinate.jsonPointer)).toEqual(["/messages/0","/messages/1"]);
    for(const name of fs.readdirSync(f.out)) { expect(fs.statSync(join(f.out,name)).mode&0o777).toBe(0o600); expect(fs.readFileSync(join(f.out,name),"utf8")).not.toMatch(/BODY_CANARY|TOOL_CANARY|KEY_CANARY/); }
    expect(fs.statSync(f.out).mode&0o777).toBe(0o700); expect(fs.existsSync(join(f.out,"manifest.json.pending"))).toBe(false);
    expect(p.stdout.toString()+p.stderr.toString()).not.toMatch(/CANARY|synthetic-custody|chat.json/);
    expect(cli(f).exitCode).toBe(1); // fresh outputs only
  } finally {f.clean();}
});
test("complete source validation, exact pair/pins/count/admission and LF rejection precede writes", () => {
  for(const change of [ (f:any)=>f.source.documentHash="a".repeat(64), (f:any)=>f.source.stat.ino="0",
    (f:any)=>f.source.documentBytes++, (f:any)=>f.source.provider="codex", (f:any)=>f.source.sourceFormat="raw",
    (f:any)=>f.source.coordinateKind="lf", (f:any)=>f.spec.expectedMessages=1, (f:any)=>f.spec.expectedSessionId="wrong",
    (f:any)=>f.source.admission="admitted", (f:any)=>f.source.originMachine="filename-inference",
    (f:any)=>f.source.coordinatesPath="CANARY", (f:any)=>f.spec.maxOutputRows=1 ]) {
    const f=fixture(); try {change(f);f.save(); const p=cli(f);expect(p.exitCode).toBe(1);expect(fs.existsSync(f.out)).toBe(false);expect(p.stderr.toString()).not.toContain("CANARY");} finally {f.clean();}
  }
  for(const raw of [Buffer.from('{"messages":[]} CANARY'),Buffer.from('{"messages":[],"messages":[]}'),Buffer.from('{"messages":[]}\n{"messages":[]}')]) {
    const f=fixture(raw);try {expect(cli(f).exitCode).toBe(1);expect(fs.existsSync(f.out)).toBe(false);} finally {f.clean();}
  }
});
test("retained evidence hash is binding only; missing metadata and unsupported elements stay explicit", async () => {
  const f=fixture(Buffer.from('{"sessionId":"synthetic","messages":[null,{"tokens":{"input":"CANARY","CANARY_KEY":2}}]}'));
  try {f.source.admission="retained";Object.assign(f.source,{admissionEvidenceHash:"b".repeat(64)});f.save();
    const r=await exportGeminiJson(f.manifest,f.out);expect(r.admissionAuthority).toBe("NOT_ATTESTED");
    const rows=fs.readFileSync(join(f.out,"metadata.ndjson"),"utf8").trim().split("\n").map(x=>JSON.parse(x));
    expect(rows[0].status).toBe("UNSUPPORTED_ELEMENT");expect(rows[1].model.presence).toBe("absent");
    expect(rows[1].nativeGeminiTokens.presence).toBe("UNRESOLVED");expect(JSON.stringify(r)+JSON.stringify(rows)).not.toContain("CANARY");
    expect(rows[1].gaps).toContain("timestamp:absent");expect(r.gaps).toContain("nativeProjectHash:absent");
  } finally {f.clean();}
});
test("symlink aliases and nonignored repository destinations fail closed", () => {
  const f=fixture();try {
    fs.symlinkSync(f.dir,join(f.dir,"alias"));
    for(const out of [join(f.dir,"alias","out"),resolve("gemini-export-unignored")]) {
      expect(()=>exportGeminiJson(f.manifest,out)).toThrow();expect(fs.existsSync(out)).toBe(false);
    }
    fs.symlinkSync(f.path,join(f.dir,"link"));f.source.path=join(f.dir,"link");f.save();expect(cli(f).exitCode).toBe(1);
  } finally {f.clean();}
});
test("preflight/write/final publication failures never publish a consumable manifest", () => {
  for(const phase of ["preflight","write","manifest"]) {
    const f=fixture();let mock:any;
    try {
      if(phase==="write") mock=spyOn(Budget.prototype,"write").mockImplementation(()=>{throw new Error("CANARY");});
      if(phase==="manifest") mock=spyOn(GeminiOutput.prototype,"publish").mockImplementation(()=>{throw new Error("CANARY");});
      if(phase==="preflight") { mock=spyOn(fs,"statfsSync").mockReturnValue({bfree:1,bavail:1,bsize:1} as any); }
      expect(()=>exportGeminiJson(f.manifest,f.out)).toThrow();expect(fs.existsSync(join(f.out,"manifest.json"))).toBe(false);
    } finally {mock?.mockRestore();f.clean();}
  }
  expect(()=>new Budget(tmpdir(),1,()=>FLOOR_BYTES+PENDING_BYTES)).toThrow("PREFLIGHT_SPACE_BUDGET");
});

test("actual encoded byte budget exhaustion has no final manifest", () => {
  const value="x".repeat(16380), f=fixture(Buffer.from(JSON.stringify({sessionId:"synthetic",projectHash:value,messages:[{id:value,type:value,model:value,timestamp:"2030-01-01T00:00:00Z"}]})));
  try {
    // The receipt repeats document metadata only once; long approved scalar metadata still counts.
    f.spec.expectedMessages=1;f.spec.maxOutputRows=1;f.source.custodyMachine="c".repeat(4096);f.source.originMachine="UNKNOWN";f.save();
    // Document metadata in the final receipt also consumes the shared byte budget.
    f.spec.scope="s".repeat(256);f.save();
    const r=cli(f);expect(r.exitCode).toBe(1);expect(r.stderr.toString()).toContain("OUTPUT_BYTES_BUDGET");
    expect(fs.existsSync(join(f.out,"manifest.json"))).toBe(false);
  } finally {f.clean();}
});
test("SIGKILL after pending-manifest fsync cannot publish completion", async () => {
  const f=fixture();try {
    const program=`import {custodyOps} from ${JSON.stringify(resolve("src/metadata/private-fs.ts"))}; import {spyOn} from "bun:test";
      import {exportGeminiJson} from ${JSON.stringify(resolve("src/metadata/gemini-export.ts"))};
      spyOn(custodyOps,"commit").mockImplementation(()=>{process.kill(process.pid,"SIGKILL");});
      exportGeminiJson(${JSON.stringify(f.manifest)},${JSON.stringify(f.out)});`;
    const child=Bun.spawn(["bun","-e",program],{stdout:"pipe",stderr:"pipe"});await child.exited;
    expect(child.signalCode).toBe("SIGKILL");expect(fs.existsSync(join(f.out,"manifest.json"))).toBe(false);
    expect(fs.existsSync(join(f.out,"manifest.json.pending"))).toBe(true);
    expect((await new Response(child.stderr).text())).toBe("");
  } finally {f.clean();}
});
