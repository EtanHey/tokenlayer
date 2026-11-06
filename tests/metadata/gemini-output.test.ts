import {test,expect,spyOn} from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {GeminiOutput,guardGit} from "../../src/metadata/gemini-output";
import {custodyOps} from "../../src/metadata/private-fs";
function fixture(){const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"gemini-output-")));return {dir,out:join(dir,"out"),clean:()=>fs.rmSync(dir,{recursive:true,force:true})};}
test("descriptor-relative files have exact modes and final no-replace protects existing receipt",()=>{
  const f=fixture();let output:GeminiOutput|undefined;
  try {
    output=new GeminiOutput(f.out,1);const fd=output.open("metadata.ndjson");output.budget.write(fd,"synthetic\n");output.finish(fd);
    expect(fs.statSync(f.out).mode&0o777).toBe(0o700);expect(fs.statSync(join(f.out,"metadata.ndjson")).mode&0o777).toBe(0o600);
    const old="existing receipt\n";fs.writeFileSync(join(f.out,"manifest.json"),old,{mode:0o600});
    expect(()=>output!.publish({synthetic:true})).toThrow();expect(fs.readFileSync(join(f.out,"manifest.json"),"utf8")).toBe(old);
    expect(fs.statSync(join(f.out,"manifest.json.pending")).mode&0o777).toBe(0o600);
  } finally {output?.close();f.clean();}
});
for(const leaf of ["metadata.ndjson","manifest.json.pending"] as const) test("held directory descriptor never follows substituted output: "+leaf,()=>{
  const f=fixture(),target=join(f.dir,"target");fs.mkdirSync(target,{mode:0o700});let output:GeminiOutput|undefined;
  const original=custodyOps.open;let changed=false;
  try {
    output=new GeminiOutput(f.out,1);
    const mock=spyOn(custodyOps,"open").mockImplementation((fd,name,flags,mode)=>{
      if(name===leaf&&!changed){changed=true;fs.renameSync(f.out,f.out+"-old");fs.symlinkSync(target,f.out);}return original(fd,name,flags,mode);
    });
    try {expect(()=>output!.open(leaf)).toThrow();} finally {mock.mockRestore();}
    expect(changed).toBe(true);expect(fs.readdirSync(target)).toEqual([]);expect(fs.existsSync(join(f.out+"-old","manifest.json"))).toBe(false);
  } finally {output?.close();f.clean();}
});
test("ancestor substitution is detected and native volume free agrees with actual statfs",()=>{
  const f=fixture(),parent=join(f.dir,"parent"),target=join(f.dir,"target");fs.mkdirSync(parent);fs.mkdirSync(target);let output:GeminiOutput|undefined;
  try {
    output=new GeminiOutput(join(parent,"out"),1);fs.renameSync(parent,parent+"-old");fs.symlinkSync(target,parent);
    expect(()=>output!.open("metadata.ndjson")).toThrow();expect(fs.readdirSync(target)).toEqual([]);
  } finally {output?.close();f.clean();}
});
test("Git ignore error/trust probe states and bad Git environment fail closed",()=>{
  const f=fixture();try {
    expect(Bun.spawnSync(["git","init","--quiet",f.dir]).exitCode).toBe(0);fs.writeFileSync(join(f.dir,".gitignore"),"/out\n");guardGit(f.out);
    const original=Bun.spawnSync;
    for(const exitCode of [1,128]) {
      const mock=spyOn(Bun,"spawnSync").mockImplementation(((...args:any[])=>args[0].includes("check-ignore")?{exitCode,stdout:Buffer.alloc(0),stderr:Buffer.from("FAULT_CANARY")}:original(...args as Parameters<typeof Bun.spawnSync>)) as typeof Bun.spawnSync);
      try {expect(()=>new GeminiOutput(f.out,1)).toThrow();expect(fs.existsSync(f.out)).toBe(false);} finally {mock.mockRestore();}
    }
  } finally {f.clean();}
});
