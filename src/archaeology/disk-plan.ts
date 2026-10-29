import { writeOut } from "../lib/egress";
import { readFileSync, writeFileSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

export function diskVerdict(importBytes: number, freeBytes: number) {
  if (!Number.isSafeInteger(importBytes) || importBytes<0 || !Number.isSafeInteger(freeBytes) || freeBytes<0) throw Error("invalid byte count");
  const overheadBytes=Math.ceil(importBytes/4),marginBytes=14*1024**3,minimumAfterImport=35*1024**3;
  const required=Math.max(importBytes+overheadBytes+marginBytes,importBytes+minimumAfterImport);
  return {after_import_free_bytes:freeBytes-importBytes,minimum_after_import_free_bytes:minimumAfterImport,import_bytes:importBytes,overhead_bytes:overheadBytes,margin_bytes:marginBytes,required_free_bytes:required,free_bytes:freeBytes,required_gib:required/1024**3,free_gib:freeBytes/1024**3,verdict:freeBytes>=required?"PASS":"FAIL"};
}
if(import.meta.main){
  const {values}=parseArgs({options:{report:{type:"string"},out:{type:"string"},"m1-free-gib":{type:"string"}}});
  if(!values.report||!values.out)throw Error("requires --report dry-run.json --out disk-plan.json");
  if(!values["m1-free-gib"]?.trim())throw Error("requires measured real free space via --m1-free-gib; unknown space fails closed (35 GiB must remain after import)");
  if(process.env.USER==="happycampr")throw Error("Phase 4 disk reporting is M4-only");
  const report:unknown=JSON.parse(readFileSync(values.report,"utf8"));
  if(!report||typeof report!=="object"||!("import_bytes" in report)||typeof report.import_bytes!=="number"||!("groups" in report)||!report.groups||typeof report.groups!=="object")throw Error("invalid dry-run report");
  const byOrigin:Record<string,number>={};
  for(const [key,value]of Object.entries(report.groups)){
    if(!value||typeof value!=="object"||!("bytes" in value)||typeof value.bytes!=="number")throw Error("invalid import group");
    const origin=key.split("\t")[0];byOrigin[origin]=(byOrigin[origin]??0)+value.bytes;
  }
  if(Object.values(byOrigin).reduce((a,b)=>a+b,0)!==report.import_bytes)throw Error("import byte groups do not sum");
  const fs=statfsSync(dirname(values.out)),m4Free=fs.bavail*fs.bsize,m1Free=Math.floor(Number(values["m1-free-gib"])*1024**3);
  const result={at:new Date().toISOString(),import_bytes:report.import_bytes,per_origin_import_bytes:byOrigin,destinations:{m4:{...diskVerdict(report.import_bytes,m4Free),free_evidence:"native statfs at report time; current scratch already allocated"},m1:{...diskVerdict(report.import_bytes,m1Free),free_evidence:"explicit measured real free space from --m1-free-gib; no M1 probe performed"}},note:"Each destination verdict budgets the whole current import projection, not version/copy bytes. At least 35 GiB real free must remain after import (before the separate 25% overhead budget); the 25% overhead plus 14 GiB reserve gate also applies. Unfetched history is additional unknown demand; remeasure before apply."};
  writeFileSync(values.out,JSON.stringify(result,null,2)+"\n");writeOut(JSON.stringify(result.destinations));
  if(Object.values(result.destinations).some(d=>d.verdict==="FAIL")){writeOut("Disk plan FAIL: each destination requires at least 35 GiB real free after import and the overhead/reserve budget.");process.exitCode=1;}
}
