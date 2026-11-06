import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { geminiStatPin } from "../../src/metadata/gemini-json";
import { hash } from "../../src/metadata/stream";
const cli=resolve("src/metadata/gemini-main.ts");
function fixture() {
  const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"gemini-custody-"))), parent=join(dir,"parent");fs.mkdirSync(parent,{mode:0o700});
  const path=join(dir,"chat.json"), manifest=join(dir,"input.json"), out=join(parent,"out"), target=join(dir,"target"), hook=join(dir,"hook.ts");
  const raw=Buffer.from('{"sessionId":"s","messages":[{"id":"a","type":"gemini","content":"BODY_CANARY","tokens":{"input":1}}]}');
  fs.writeFileSync(path,raw);fs.mkdirSync(target,{mode:0o755});const old='{"existing":"PRESERVE"}\n';fs.writeFileSync(join(target,"manifest.json"),old);
  fs.writeFileSync(manifest,JSON.stringify({version:1,kind:"tokenlayer-gemini-json-export-input",scope:"synthetic-r1",maxOutputRows:1,expectedMessages:1,expectedSessionId:"s",source:{path,provider:"gemini-cli",sourceFormat:"gemini-chat-json",coordinateKind:"json-utf8-span-v1",admission:"synthetic",custodyMachine:"synthetic",originMachine:"UNKNOWN",originProof:"UNKNOWN",originalPath:"UNKNOWN",sourceRoot:dir,rootKind:"native-gemini-cli-tmp",documentBytes:raw.length,documentHash:hash(raw),stat:geminiStatPin(fs.lstatSync(path,{bigint:true}))}}));
  const run=(env={},preload=false)=>Bun.spawnSync([process.execPath,...(preload?["--preload",hook]:[]),cli,manifest,out],{env:{...process.env,...env}});
  const saveHook=(code:string)=>fs.writeFileSync(hook,code);
  const clean=()=>fs.rmSync(dir,{recursive:true,force:true});
  return {dir,parent,path,manifest,out,target,old,hook,run,saveHook,clean};
}
for(const phase of ["metadata.ndjson","manifest.json.pending"]) test("R1 real CLI rejects directory substitution at "+phase,()=>{
  const f=fixture();try {
    f.saveHook(`import * as fs from "node:fs";import {spyOn} from "bun:test";
      import {custodyOps} from ${JSON.stringify(resolve("src/metadata/private-fs.ts"))};
      const original=custodyOps.open;let once=false;
      spyOn(custodyOps,"open").mockImplementation((fd,name,flags,mode)=>{if(name===${JSON.stringify(phase)}&&!once){once=true;fs.renameSync(${JSON.stringify(f.out)},${JSON.stringify(f.out+"-original")});fs.symlinkSync(${JSON.stringify(f.target)},${JSON.stringify(f.out)});}return original(fd,name,flags,mode);});`);
    const p=f.run({},true);expect(p.exitCode).toBe(1);expect(fs.existsSync(f.out+"-original")).toBe(true);expect(fs.lstatSync(f.out).isSymbolicLink()).toBe(true);expect(fs.readFileSync(join(f.target,"manifest.json"),"utf8")).toBe(f.old);
    expect(fs.existsSync(join(f.target,"metadata.ndjson"))).toBe(false);expect(fs.existsSync(join(f.out+"-original","manifest.json"))).toBe(false);
  } finally {f.clean();}
});
test("R1 Git errors are refusal before mkdir; normal ignored and outside controls",()=>{
  for(const fault of ["GIT_DIR","preload","normal","ignored","outside"]) {
    const f=fixture();try {
      if(fault!=="outside") expect(Bun.spawnSync(["git","init","--quiet",f.parent]).exitCode).toBe(0);
      if(fault==="ignored") fs.writeFileSync(join(f.parent,".gitignore"),"/out\n");
      if(fault==="preload") f.saveHook(`import {spyOn} from "bun:test";const original=Bun.spawnSync;spyOn(Bun,"spawnSync").mockImplementation((...a)=>a[0]?.includes("rev-parse")?{exitCode:128,stdout:Buffer.alloc(0),stderr:Buffer.from("synthetic discovery failure")}:original(...a));`);
      const p=f.run(fault==="GIT_DIR"?{GIT_DIR:join(f.dir,"missing-git")}: {},fault==="preload");
      expect(p.exitCode).toBe(["ignored","outside"].includes(fault)?2:1);
      expect(fs.existsSync(f.out)).toBe(["ignored","outside"].includes(fault));
      if(fault==="GIT_DIR")expect(p.stderr.toString()).toContain("OUTPUT_GIT_ENV_UNKNOWN");if(fault==="preload")expect(p.stderr.toString()).toContain("OUTPUT_GIT_UNKNOWN");
    } finally {f.clean();}
  }
});
for(const leaf of ["metadata.ndjson","manifest.json.pending"]) test("R1 real CLI rejects ancestor replacement at "+leaf,()=>{
  const f=fixture();try {
    f.saveHook(`import * as fs from "node:fs";import {spyOn} from "bun:test";
      import {custodyOps} from ${JSON.stringify(resolve("src/metadata/private-fs.ts"))};const original=custodyOps.open;let changed=false;
      spyOn(custodyOps,"open").mockImplementation((fd,name,flags,mode)=>{if(name===${JSON.stringify(leaf)}&&!changed){changed=true;fs.renameSync(${JSON.stringify(f.parent)},${JSON.stringify(f.parent+"-old")});fs.symlinkSync(${JSON.stringify(f.target)},${JSON.stringify(f.parent)});}return original(fd,name,flags,mode);});`);
    const p=f.run({},true);expect(p.exitCode).toBe(1);expect(fs.existsSync(f.parent+"-old")).toBe(true);expect(fs.lstatSync(f.parent).isSymbolicLink()).toBe(true);expect(fs.readdirSync(f.target)).toEqual(["manifest.json"]);
    expect(fs.readFileSync(join(f.target,"manifest.json"),"utf8")).toBe(f.old);expect(fs.existsSync(join(f.parent+"-old","out","manifest.json"))).toBe(false);
  } finally {f.clean();}
});
test("real CLI no-replace commit and short-write/fsync/kill failures preserve publication contract",()=>{
  for(const phase of ["existing-final","short-success","short-zero","short-throw","fsync-data","fsync-pending","commit-throw","kill-before","kill-after","primitive-missing","floor"]) {
    const f=fixture();try {
      f.saveHook(`import * as fs from "node:fs";import * as ffi from "bun:ffi";import {spyOn} from "bun:test";
        import {custodyOps} from ${JSON.stringify(resolve("src/metadata/private-fs.ts"))};
        const phase=${JSON.stringify(phase)}, originalCommit=custodyOps.commit, originalWrite=fs.writeSync, originalFsync=fs.fsyncSync;let writes=0,syncs=0;
        if(phase==="primitive-missing")spyOn(ffi,"dlopen").mockImplementation(()=>{throw Error("FAULT_CANARY");});
        if(phase==="floor"){const free=custodyOps.free;spyOn(custodyOps,"free").mockImplementation(fd=>writes?0:free(fd));spyOn(fs,"writeSync").mockImplementation((...a)=>{writes++;return originalWrite(...a);});}
        if(phase.startsWith("short")) spyOn(fs,"writeSync").mockImplementation((fd,b,at,len,pos)=>{writes++;if(writes===1)return originalWrite(fd,b,at,Math.min(7,len),pos);if(phase==="short-zero")return 0;if(phase==="short-throw")throw Error("FAULT_CANARY");return originalWrite(fd,b,at,len,pos);});
        if(phase.startsWith("fsync"))spyOn(fs,"fsyncSync").mockImplementation(fd=>{if(++syncs===(phase==="fsync-data"?1:2))throw Error("FAULT_CANARY");return originalFsync(fd);});
        spyOn(custodyOps,"commit").mockImplementation(fd=>{
          if(phase==="existing-final")fs.writeFileSync(${JSON.stringify(join(f.out,"manifest.json"))},${JSON.stringify(f.old)},{flag:"wx",mode:0o600});
          if(phase==="commit-throw")throw Error("FAULT_CANARY");if(phase==="kill-before")process.kill(process.pid,"SIGKILL");
          originalCommit(fd);if(phase==="kill-after")process.kill(process.pid,"SIGKILL");});`);
      const p=f.run({},true), final=join(f.out,"manifest.json");
      if(phase.startsWith("kill"))expect(p.signalCode).toBe("SIGKILL");else expect(p.exitCode).toBe(phase==="short-success"?2:1);
      expect(p.stderr.toString()).not.toContain("FAULT_CANARY");
      if(phase==="existing-final")expect(fs.readFileSync(final,"utf8")).toBe(f.old);
      else if(["short-success","kill-after"].includes(phase)) {
        const r=JSON.parse(fs.readFileSync(final,"utf8")),bytes=fs.readFileSync(join(f.out,"metadata.ndjson"));expect(r.outputs.metadataSha256).toBe(hash(bytes));expect(r.outputs.metadataBytes).toBe(bytes.length);expect(bytes.toString()).not.toContain("BODY_CANARY");
      } else expect(fs.existsSync(final)).toBe(false);
    } finally {f.clean();}
  }
});
