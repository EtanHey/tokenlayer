import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Budget, ProjectionError } from "./output";
import { atCwd, closeOnExec, custodyOps, directoryFlags } from "./private-fs";
const fail=(code:string):never=>{throw new ProjectionError(code);};
const identity=(s:fs.Stats)=>`${s.dev}:${s.ino}`;
/** A Git error is never outside-repo evidence. Outside requires no ancestor .git plus exact C diagnostic. */
export function guardGit(out:string) {
  if(Object.keys(process.env).some(k=>k.startsWith("GIT_")&&k!=="GIT_PAGER")) fail("OUTPUT_GIT_ENV_UNKNOWN");
  const env={...process.env,LC_ALL:"C",LANGUAGE:"C"};
  const run=(args:string[])=>Bun.spawnSync(["git","--no-pager","-C",dirname(out),...args],{env,timeout:5000,maxBuffer:65536});
  const r=run(["rev-parse","--show-toplevel"]);
  if(r.exitCode===0 && !r.stderr.length) {
    const root=r.stdout.toString().trim();
    if(!root || fs.realpathSync(root)!==root || !(dirname(out)===root||dirname(out).startsWith(root+"/"))) fail("OUTPUT_GIT_UNKNOWN");
    const ignored=run(["check-ignore","--quiet","--",out]);
    if(ignored.exitCode!==0 || ignored.stderr.length || ignored.stdout.length) fail("OUTPUT_NOT_IGNORED");return;
  }
  // Fail closed for config/trust/executable/probe faults; never match a broad exit128 or translated prefix.
  if(r.exitCode!==128 || r.stdout.length || r.stderr.toString()!=="fatal: not a git repository (or any of the parent directories): .git\n") fail("OUTPUT_GIT_UNKNOWN");
  let p=dirname(out);
  for(let n=0;;n++) {
    if(n>=128) fail("OUTPUT_PATH_BOUND");
    try {fs.lstatSync(join(p,".git"));fail("OUTPUT_GIT_UNKNOWN");}
    catch(e) {if((e as NodeJS.ErrnoException).code!=="ENOENT") throw e;}
    if(p==="/") return;p=dirname(p);
  }
}
/** Holds each canonical ancestor, then the fresh directory, until the no-replace commit. */
export class GeminiOutput {
  readonly out:string;
  readonly budget:Budget;
  private chain:{fd:number;name:string;id:string}[]=[];
  private files=new Set<number>();
  constructor(path:string,maxRows:number) {
    this.out=resolve(path);
    try {
      if(this.out.length>4096 || fs.realpathSync(dirname(this.out))!==dirname(this.out)) fail("OUTPUT_PATH_ALIAS");
      const parts=dirname(this.out).split("/").filter(Boolean);
      if(parts.length>126) fail("OUTPUT_PATH_BOUND");
      const root=custodyOps.open(atCwd(),"/",directoryFlags);this.chain.push({fd:root,name:"/",id:identity(fs.fstatSync(root))});
      for(const name of parts) this.anchor(name);
      this.assert();guardGit(this.out);this.assert();
      const parent=this.chain.at(-1)!.fd;
      new Budget(this.out,maxRows,()=>custodyOps.free(parent)); // no mkdir before complete reservation
      custodyOps.mkdir(parent,this.out.split("/").at(-1)!);
      this.anchor(this.out.split("/").at(-1)!);
      this.assert();
      if((fs.fstatSync(this.fd).mode&0o777)!==0o700) fail("OUTPUT_MODE_INVALID");
      this.budget=new Budget(this.out,maxRows,()=>{this.assert();return custodyOps.free(this.fd);});
    } catch(e) {this.close();throw e;}
  }
  private get fd(){return this.chain.at(-1)!.fd;}
  private anchor(name:string) {
    const fd=custodyOps.open(this.fd,name,directoryFlags);this.chain.push({fd,name,id:identity(fs.fstatSync(fd))});
  }
  assert() {
    for(let i=1;i<this.chain.length;i++) {
      const edge=this.chain[i],fd=custodyOps.open(this.chain[i-1].fd,edge.name,directoryFlags);
      try {if(identity(fs.fstatSync(fd))!==edge.id) fail("OUTPUT_DIRECTORY_CHANGED");} finally {fs.closeSync(fd);}
    }
  }
  open(name:"metadata.ndjson"|"manifest.json.pending") {
    this.budget.check();
    const fd=custodyOps.open(this.fd,name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|closeOnExec,0o600);
    this.files.add(fd);this.assert();
    if((fs.fstatSync(fd).mode&0o777)!==0o600) fail("OUTPUT_MODE_INVALID");return fd;
  }
  finish(fd:number) {fs.fsyncSync(fd);fs.closeSync(fd);this.files.delete(fd);}
  publish(receipt:unknown) {
    const fd=this.open("manifest.json.pending");this.budget.write(fd,JSON.stringify(receipt,null,2)+"\n");this.finish(fd);
    this.budget.check();custodyOps.commit(this.fd); // terminal commit point: no fallible work afterward
  }
  close() {
    for(const fd of this.files) {try {fs.closeSync(fd);} catch {}}this.files.clear();
    for(const {fd} of this.chain.reverse()) {try {fs.closeSync(fd);} catch {}}this.chain=[];
  }
}
