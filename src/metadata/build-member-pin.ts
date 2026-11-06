import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeErr, writeOut } from "../lib/egress";
import { FLOOR_BYTES, PENDING_BYTES, physicalFree, ProjectionError } from "./output";
import { privateOutput } from "./run";
import { hash, RECORD_CAP } from "./stream";

const identityKeys = ["provider", "custodyMachine", "originMachine", "originProof", "containerDriveId", "containerHash",
  "memberPath", "memberHash", "physicalRepresentationHash"];
const statKeys = ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const;
const coordinateKeys = ["firstLFLine", "decodedOffset", "decodedBytes", "records"];
const limitKeys = ["compressedBytes", "decodedBytes", "ratio", "rows", "millis", "outputBytes"];
const pin = (v:unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const fail = (code:string):never => { throw new ProjectionError(code); };
const same = (a:any,b:any,keys:readonly string[]) => !!a && !!b && keys.every(k=>a[k]===b[k]);
const pick = (v:any,keys:readonly string[]) => Object.fromEntries(keys.map(k=>[k,v[k]]));
const stable = (s:any,b:any,path:string) => same(s,b,statKeys) && same(lstatSync(path),b,statKeys);
/** Bounded, no-follow read. Receipt/manifest bytes and identity are checked on the same descriptor. */
function document(path:string) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(!before.isFile() || before.size>RECORD_CAP) fail("MEMBER_DOCUMENT_INVALID");
    const buffer=Buffer.alloc(RECORD_CAP+1); let n=0, got=0;
    while(n<buffer.length && (got=readSync(fd,buffer,n,buffer.length-n,null))) n+=got;
    const bytes=buffer.subarray(0,n);
    if(n>RECORD_CAP || !stable(fstatSync(fd),before,path)) fail("MEMBER_DOCUMENT_INVALID");
    return { value:JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)), sha256:hash(bytes) };
  } finally {closeSync(fd);}
}
/** One explicit physical member; no enumeration, network, native queues or inferred admission. */
export async function buildMemberPin(manifestPath:string, outputPath:string):Promise<any> {
  const started=performance.now(), opened:number[]=[];
  let input:Awaited<ReturnType<typeof open>>|undefined, child:ReturnType<typeof spawn>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const spec=document(manifestPath), m=spec.value, l=m.limits;
    if(m.version!==1 || typeof m.scope!=="string" || !m.scope.trim() || m.scope.length>256 ||
      !["synthetic","admitted"].includes(m.admission) || typeof m.sourcePath!=="string" ||
      !pin(m.admissionReceiptSha256) || typeof m.admissionReceiptPath!=="string" ||
      identityKeys.some(k=>typeof m.identity?.[k]!=="string" || !m.identity[k] || m.identity[k].length>4096) ||
      !["codex","claude"].includes(m.identity.provider) || !pin(m.identity.memberHash) ||
      !pin(m.identity.physicalRepresentationHash) ||
      !["UNKNOWN","NOT_APPLICABLE"].includes(m.identity.containerHash) && !pin(m.identity.containerHash)) fail("MEMBER_SPEC_INVALID");
    for(const [key,max] of Object.entries({compressedBytes:16*1024**3,decodedBytes:64*1024**3,rows:1_000_000,millis:600_000,outputBytes:128*1024**3}))
      if(!Number.isSafeInteger(l?.[key]) || l[key]<1 || l[key]>max) fail("MEMBER_LIMIT_INVALID");
    if(!Number.isFinite(l.ratio) || l.ratio<=0 || l.ratio>1_000_000) fail("MEMBER_LIMIT_INVALID");
    const admission=document(m.admissionReceiptPath), a=admission.value, coordinates=m.coordinates;
    if(admission.sha256!==m.admissionReceiptSha256 || a.version!==1 || a.kind!=="tokenlayer-member-admission" ||
      a.scope!==m.scope || a.admission!==m.admission || !same(a.identity,m.identity,identityKeys) ||
      !same(a.physicalIdentity,m.physicalIdentity,statKeys) || !same(a.coordinates,coordinates,coordinateKeys) ||
      coordinates.firstLFLine!==1 || coordinates.decodedOffset!==0 ||
      !Number.isSafeInteger(coordinates.records) || coordinates.records<1 ||
      !Number.isSafeInteger(coordinates.decodedBytes) || coordinates.decodedBytes<1 ||
      statKeys.some(k=>!Number.isFinite(m.physicalIdentity?.[k]))) fail("MEMBER_ADMISSION_INVALID");
    input=await open(m.sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await input.stat();
    if(!before.isFile() || !same(before,m.physicalIdentity,statKeys)) fail("MEMBER_SOURCE_UNSTABLE");
    if(before.size>l.compressedBytes) fail("MEMBER_COMPRESSEDBYTES_CAP");
    const parent=realpathSync(dirname(resolve(outputPath)));
    if(physicalFree(parent)<FLOOR_BYTES+PENDING_BYTES+l.outputBytes) fail("MEMBER_PREFLIGHT_SPACE");
    const out=privateOutput(outputPath);
    let used=0;
    const space=(bytes=0)=>{if(physicalFree(out)<FLOOR_BYTES+PENDING_BYTES+bytes) fail("MEMBER_SPACE_FLOOR");};
    const time=()=>{if(performance.now()-started>=l.millis) fail("MEMBER_TIME_CAP");};
    const write=(fd:number,b:Buffer)=>{
      time(); if(used+b.length>l.outputBytes) fail("MEMBER_OUTPUT_CAP");
      used+=b.length;
      for(let at=0;at<b.length;) {
        space(b.length-at); const n=writeSync(fd,b,at,b.length-at); if(n<=0) fail("MEMBER_SHORT_WRITE"); at+=n;
      }
    };
    const output=(name:string)=>{const fd=openSync(join(out,name),"wx",0o600);opened.push(fd);return fd;};
    const decodedPath=join(out,"decoded.ndjson"), coordinatesPath=join(out,"coordinates.ndjson");
    const decoded=output("decoded.ndjson"), sidecar=output("coordinates.ndjson");
    space();time();
    const proc=child=spawn("zstd",["-dc","-q"],{stdio:["pipe","pipe","pipe"]});
    let failure:unknown, stderrBytes=0;
    const stop=(error:unknown)=>{failure??=error;proc.kill("SIGKILL");proc.stdin!.destroy();proc.stdout!.destroy();};
    proc.on("error",()=>stop(new ProjectionError("MEMBER_DECODE_FAILED")));
    proc.stdin!.on("error",()=>stop(new ProjectionError("MEMBER_DECODE_FAILED")));
    proc.stderr!.on("error",()=>stop(new ProjectionError("MEMBER_DECODE_FAILED")));
    proc.stderr!.on("data",(b:Buffer)=>{
      stderrBytes+=b.length; if(stderrBytes>64*1024) stop(new ProjectionError("MEMBER_DECODER_STDERR_CAP"));
    }); // drained and discarded; never retained or echoed
    const exited=new Promise<number|null>(r=>proc.once("close",r));
    timer=setTimeout(()=>stop(new ProjectionError("MEMBER_TIME_CAP")),Math.max(1,l.millis-(performance.now()-started)));
    const physicalHash=createHash("sha256"), decodedHash=createHash("sha256"), sidecarHash=createHash("sha256");
    let compressedBytes=0, decodedBytes=0, rows=0, offset=0, recordBytes=0, recordHash=createHash("sha256");
    const feed=async()=>{
      const buffer=Buffer.alloc(64*1024);
      for(;;) {
        time(); const {bytesRead:n}=await input!.read(buffer,0,buffer.length,null); if(!n) break;
        compressedBytes+=n; if(compressedBytes>l.compressedBytes) fail("MEMBER_COMPRESSEDBYTES_CAP");
        const bytes=buffer.subarray(0,n); physicalHash.update(bytes);
        await new Promise<void>((r,j)=>proc.stdin!.write(bytes,e=>e?j(e):r())); // at most one pending 64KiB write
      }
      proc.stdin!.end();
    };
    const consume=async()=>{
      for await(const bytes of proc.stdout!) {
        const b=bytes as Buffer; time(); decodedBytes+=b.length;
        if(decodedBytes>l.decodedBytes) fail("MEMBER_DECODEDBYTES_CAP");
        if(decodedBytes>before.size*l.ratio) fail("MEMBER_RATIO_CAP");
        decodedHash.update(b); write(decoded,b);
        for(let at=0;at<b.length;) {
          const lf=b.indexOf(10,at), end=lf<0?b.length:lf+1;
          recordHash.update(b.subarray(at,end)); recordBytes+=end-at;
          if(lf>=0) {
            if(++rows>l.rows) fail("MEMBER_ROWS_CAP");
            const line=Buffer.from(JSON.stringify({originalLFLine:rows,decodedOffset:offset,
              recordHash:recordHash.digest("hex"),recordBytes})+"\n");
            write(sidecar,line); sidecarHash.update(line); offset+=recordBytes; recordBytes=0; recordHash=createHash("sha256");
          }
          at=end;
        }
      }
    };
    const guard=(p:Promise<void>)=>p.catch(e=>stop(e instanceof ProjectionError?e:new ProjectionError("MEMBER_DECODE_FAILED")));
    const results=await Promise.all([guard(feed()),guard(consume()),exited]);
    clearTimeout(timer); time();
    if(failure) throw failure;
    if(results[2]!==0) fail("MEMBER_DECODE_FAILED");
    if(!stable(await input.stat(),before,m.sourcePath) || compressedBytes!==before.size) fail("MEMBER_SOURCE_UNSTABLE");
    if(physicalHash.digest("hex")!==m.identity.physicalRepresentationHash) fail("MEMBER_PHYSICAL_PIN");
    if(recordBytes) fail("MEMBER_TERMINAL_NON_LF");
    if(decodedHash.digest("hex")!==m.identity.memberHash) fail("MEMBER_DECODED_PIN");
    if(rows!==coordinates.records || decodedBytes!==coordinates.decodedBytes) fail("MEMBER_COORDINATES_INVALID");
    const source={...pick(m.identity,identityKeys),path:decodedPath,inputSha256:m.identity.memberHash,format:"raw",admission:m.admission,
      admissionEvidenceHash:admission.sha256,coordinatesPath,coordinatesSha256:sidecarHash.digest("hex")};
    const receipt={version:1,scope:m.scope,kind:"tokenlayer-member-pin",sources:[source],maxOutputRows:rows,
      status:m.admission==="synthetic"?"PIN_BUILT_SYNTHETIC_ONLY":"PIN_BUILT_ADMISSION_RECEIPT_VERIFIED",
      rawHistoryAcceptance:"HOLD",inputManifestSha256:spec.sha256,admissionReceiptSha256:admission.sha256,
      physicalIdentity:pick(m.physicalIdentity,statKeys),coordinates:pick(coordinates,coordinateKeys),decoder:{command:"zstd -dc -q",exit:0},limits:pick(l,limitKeys),
      compressedBytes,decodedBytes,rows,outputBytesBeforeManifest:used};
    for(const fd of opened) fsyncSync(fd);
    const manifest=output("manifest.json.pending");write(manifest,Buffer.from(JSON.stringify(receipt)+"\n"));fsyncSync(manifest);
    time();space();
    if(!stable(await input.stat(),before,m.sourcePath)) fail("MEMBER_SOURCE_UNSTABLE");
    renameSync(join(out,"manifest.json.pending"),join(out,"manifest.json"));
    return receipt;
  } catch(error) {throw error instanceof ProjectionError?error:new ProjectionError("MEMBER_IO_INVALID");}
  finally {clearTimeout(timer);child?.kill("SIGKILL");await input?.close();for(const fd of opened) closeSync(fd);}
}
if(import.meta.main) {
  const [manifest,out,...extra]=process.argv.slice(2);
  try {
    if(!manifest || !out || extra.length) fail("MEMBER_ARGUMENTS_INVALID");
    const r=await buildMemberPin(manifest,out);writeOut(JSON.stringify({status:r.status,rows:r.rows,rawHistoryAcceptance:"HOLD"}));
  } catch(error) {writeErr(`REJECTED:${error instanceof ProjectionError?error.message:"MEMBER_IO_INVALID"}`);process.exitCode=1;}
}
