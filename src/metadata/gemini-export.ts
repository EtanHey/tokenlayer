import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { GEMINI_LIMITS, geminiStatPin, readGeminiJson } from "./gemini-json";
import { Budget, FLOOR_BYTES, PENDING_BYTES, ProjectionError } from "./output";
import { GeminiOutput } from "./gemini-output";
import { hash, RECORD_CAP } from "./stream";

const fail = (code:string):never => { throw new ProjectionError(code); };
const pin = (v:unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v:unknown) => typeof v === "string" && v.length > 0 && v.length <= 4096;
const keys = (v:any, allowed:readonly string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k=>allowed.includes(k));
const sourceKeys = ["path","provider","sourceFormat","coordinateKind","admission","admissionEvidenceHash","custodyMachine",
  "originMachine","originProof","originalPath","sourceRoot","rootKind","documentBytes","documentHash","stat"];
const statKeys = ["dev","ino","size","birthtimeNs","mtimeNs","ctimeNs"] as const;
/** Small explicit spec, bounded descriptor read and stable canonical identity; errors never echo bytes. */
function manifest(path:string) {
  path=resolve(path);
  if(fs.realpathSync(path)!==path) fail("GEMINI_MANIFEST_PATH");
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile() || before.size<1 || before.size>BigInt(RECORD_CAP)) fail("GEMINI_MANIFEST_BOUND");
    const raw=Buffer.alloc(Number(before.size)+1);let at=0;
    while(at<raw.length) {const n=fs.readSync(fd,raw,at,raw.length-at,null);if(!n) break;at+=n;}
    const same=(s:fs.BigIntStats)=>JSON.stringify(geminiStatPin(s))===JSON.stringify(geminiStatPin(before));
    if(at!==Number(before.size) || !same(fs.fstatSync(fd,{bigint:true})) || !same(fs.lstatSync(path,{bigint:true})) || fs.realpathSync(path)!==path)
      fail("GEMINI_MANIFEST_UNSTABLE");
    const bytes=raw.subarray(0,at);
    let m:any;try {m=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));} catch {fail("GEMINI_MANIFEST_INVALID");}
    return {m,manifestHash:hash(bytes)};
  } finally {fs.closeSync(fd);}
}
const fieldGaps = (v:any, names:readonly string[]) => names.flatMap(k=>v[k]?.presence === "value" || v[k]?.presence === "zero" ? [] : [`${k}:${v[k]?.presence ?? "absent"}`]);
/** One pinned JSON revision. NDJSON is output serialization only; no LF/native admission. */
export function exportGeminiJson(manifestPath:string, outputPath:string) {
  let output:GeminiOutput|undefined;
  try {
    const {m,manifestHash}=manifest(manifestPath), s=m.source;
    if(!keys(m,["version","kind","scope","maxOutputRows","expectedMessages","expectedSessionId","source"]) ||
      m.version!==1 || m.kind!=="tokenlayer-gemini-json-export-input" || !text(m.scope) || m.scope.length>256 ||
      !Number.isSafeInteger(m.maxOutputRows) || m.maxOutputRows<1 || m.maxOutputRows>GEMINI_LIMITS.messages ||
      !Number.isSafeInteger(m.expectedMessages) || m.expectedMessages<0 || m.expectedMessages>m.maxOutputRows || !text(m.expectedSessionId) ||
      !keys(s,sourceKeys) || s.provider!=="gemini-cli" || s.sourceFormat!=="gemini-chat-json" || s.coordinateKind!=="json-utf8-span-v1" ||
      !["synthetic","retained","admitted"].includes(s.admission) || (s.admission!=="synthetic" && !pin(s.admissionEvidenceHash)) ||
      (s.admissionEvidenceHash!==undefined && !pin(s.admissionEvidenceHash)) || !text(s.custodyMachine) ||
      s.originMachine!=="UNKNOWN" || s.originProof!=="UNKNOWN" || s.originalPath!=="UNKNOWN" ||
      !text(s.path) || !text(s.sourceRoot) || s.rootKind!=="native-gemini-cli-tmp" ||
      !s.path.startsWith(s.sourceRoot+"/") || fs.realpathSync(s.sourceRoot)!==s.sourceRoot ||
      !pin(s.documentHash) || !keys(s.stat,statKeys) || statKeys.some(k=>typeof s.stat[k]!=="string" || !/^\d{1,30}$/.test(s.stat[k])))
      fail("GEMINI_EXPORT_SPEC_INVALID");
    const parent=fs.realpathSync(dirname(resolve(outputPath)));
    if(join(parent,resolve(outputPath).split("/").at(-1)!)!==resolve(outputPath)) fail("GEMINI_OUTPUT_PATH_ALIAS");
    new Budget(parent,m.maxOutputRows); // unchanged physical floor and complete bounded reservation
    const observedFrom=new Date().toISOString(), projection=readGeminiJson(s.path,s), observedTo=new Date().toISOString();
    if(projection.messages.length!==m.expectedMessages || projection.nativeSessionId.presence!=="value" || projection.nativeSessionId.value!==m.expectedSessionId)
      fail("GEMINI_EXPORT_EXPECTATION_PIN");
    // Complete input validation precedes the first output mkdir/write. Reader caps cannot be raised here.
    const {messages,...document}=projection;
    const gaps=["originMachine","originProof","originalPath","historicalWriterVersion","providerEndpoint","accountIdentity",
      "upstreamPresence","uniqueRequestIdentity","counterInclusionAndCompleteness","fullRootCoverage",
      ...fieldGaps(document,["nativeSessionId","nativeProjectHash","startTime","lastUpdated"])];
    const provenance={custodyMachine:s.custodyMachine,originMachine:"UNKNOWN",originProof:"UNKNOWN",originalPath:"UNKNOWN",
      sourceLocator:s.path,sourceRoot:s.sourceRoot,rootKind:s.rootKind,memberPath:s.path,memberPathBasis:"CURRENT_CUSTODY_LOCATOR",
      memberHash:s.documentHash,physicalRepresentationHash:s.documentHash,containerDriveId:"NOT_APPLICABLE",containerHash:"NOT_APPLICABLE",
      stat:s.stat,observedFrom,observedTo,admission:s.admission,admissionEvidenceHash:s.admissionEvidenceHash??"NOT_APPLICABLE",admissionAuthority:"NOT_ATTESTED"};
    output=new GeminiOutput(outputPath,m.maxOutputRows);const budget=output.budget;
    const fd=output.open("metadata.ndjson");
    const digest=createHash("sha256");let metadataBytes=0,uninspected=0;
    for(const row of messages) {
      const {documentHash,documentBytes,jsonPointer,arrayIndex,outputOrdinal,utf8ByteStart,utf8ByteEndExclusive,spanBytes,spanSha256,originalLFLine,...metadata}=row;
      const rowGaps=[...gaps,...fieldGaps(row,["id","type","timestamp"])];
      if(row.status!=="PROJECTED") {rowGaps.push(row.status);uninspected++;}
      if(JSON.stringify(metadata).includes('"UNRESOLVED"')) rowGaps.push("UNSUPPORTED_METADATA_VALUE");
      if(row.type.value==="gemini") rowGaps.push(...fieldGaps(row,["model","nativeGeminiTokens"]),...fieldGaps(row.nativeGeminiTokens.fields,Object.keys(row.nativeGeminiTokens.fields)));
      const line=JSON.stringify({version:1,kind:"gemini-json-message-metadata",...metadata,provenance,
        coordinate:{documentHash,documentBytes,jsonPointer,arrayIndex,outputOrdinal,utf8ByteStart,utf8ByteEndExclusive,spanBytes,spanSha256,originalLFLine},
        gaps:[...new Set(rowGaps)],fullSourceContinuity:"UNKNOWN"})+"\n";
      budget.write(fd,line);digest.update(line);metadataBytes+=Buffer.byteLength(line);
    }
    output.finish(fd);
    const receipt={version:1,kind:"tokenlayer-gemini-json-metadata",scope:m.scope,manifestHash,status:"UNRESOLVED",complete:false,
      exportComplete:true,consumption:"PARTIAL_METADATA_ONLY",rawHistoryAcceptance:"HOLD",sourceAcceptance:"HOLD",admissionAuthority:"NOT_ATTESTED",
      document,provenance,gaps,records:messages.length,projected:messages.length-uninspected,uninspected,
      limits:{reader:GEMINI_LIMITS,maxOutputRows:m.maxOutputRows,outputBytes:budget.bytes,scratchBytes:budget.scratchBytes,physicalReserveBytes:FLOOR_BYTES,pendingBytes:PENDING_BYTES},
      outputs:{metadataSha256:digest.digest("hex"),metadataBytes},errors:[]};
    output.publish(receipt); // descriptor-relative, atomic no-replace commit after data fsync
    return receipt;
  } catch(error) {
    if(error instanceof ProjectionError) throw error;
    if(error instanceof Error && /^GEMINI_[A-Z_]+$/.test(error.message)) fail(error.message);
    return fail("GEMINI_EXPORT_IO_INVALID");
  } finally {output?.close();}
}
