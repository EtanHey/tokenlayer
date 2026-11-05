import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const witnessRoot = process.env.TOKENLAYER_METADATA_WITNESS;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (v: any): string => v && typeof v === "object" && !Array.isArray(v)
  ? "{" + Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",") + "}" : JSON.stringify(v);
(witnessRoot ? test : test.skip)("real CLI preserves pinned witness occurrences and 12→17 coordinates without raw-source claims", () => {
  const root = resolve(witnessRoot!), receiptBytes = readFileSync(join(root,"receipt.json"));
  const receipt = JSON.parse(receiptBytes.toString());
  const work = mkdtempSync(join(tmpdir(),"metadata-witness-"));
  const sources = receipt.sources.map((s: any) => {
    const packet = join(root, basename(s.output));
    expect(sha(readFileSync(packet))).toBe(s.output_sha256);
    const proc = Bun.spawnSync(["zstd","-dc",packet],{maxBuffer:2*1024*1024});
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.length).toBeLessThan(1024*1024);
    const path=join(work,basename(packet)+".decoded"); writeFileSync(path,proc.stdout,{mode:0o600});
    return { path,inputSha256:sha(proc.stdout),format:"witness",provider:"codex",admission:"witness",
      witnessReceiptHash:sha(receiptBytes),custodyMachine:"test-copy",originMachine:"UNKNOWN",originProof:"UNKNOWN",
      containerDriveId:"UNKNOWN",containerHash:"UNKNOWN",memberPath:s.path,memberHash:"UNKNOWN",
      physicalRepresentationHash:s.sha256,upstreamUninspected:s.uninspected_oversize };
  });
  const manifest=join(work,"input.json"), out=join(work,"projection");
  writeFileSync(manifest,JSON.stringify({version:1,scope:"pinned-selected-fork-packets-only",sources}),{mode:0o600});
  const proc=Bun.spawnSync(["bun",resolve("src/metadata/main.ts"),manifest,out]);
  expect(proc.exitCode).toBe(2);
  const result=JSON.parse(readFileSync(join(out,"manifest.json"),"utf8"));
  expect(result.status).toBe("UNRESOLVED"); expect(result.complete).toBe(false);
  expect(result.projected).toBe(4220); expect(result.uninspected).toBe(9);
  expect(statSync(join(out,"metadata.ndjson")).size).toBeLessThan(32*1024*1024);
  const raw=readFileSync(join(out,"metadata.ndjson"));
  expect(sha(raw)).toBe(result.outputs.metadataSha256);
  // Fixed hashed witness results only, explicitly capped above; CLI itself remains streaming.
  const rows=raw.toString().trim().split("\n").map(x=>JSON.parse(x)).filter(x=>x.status==="PROJECTED");
  const bySource: any[][]=sources.map((s: any)=>rows.filter(x=>x.coordinate.inputSha256===s.inputSha256));
  const tasks=bySource.map(rs=>new Map(rs.filter(x=>x.event.value==="task_started").map(x=>[x.refs.turn_id.value,x.clocks.witness.value])));
  const shared=[...tasks[0].keys()].filter(k=>tasks[1].has(k));
  expect(shared.length).toBe(55); expect(shared.filter(k=>tasks[0].get(k)!==tasks[1].get(k))).toHaveLength(55);
  const counters=bySource.map(rs=>rs.filter(x=>x.event.value==="token_count"));
  const key=(x:any)=>canonical([x.context.task.value,x.responseRef.value,x.usage.total_token_usage.value,x.usage.last_token_usage.value]);
  function matched(nonnull:boolean) {
    const a=new Map<string,number>();
    for(const x of counters[0]) if ((x.responseRef.value!==null)===nonnull) a.set(key(x),(a.get(key(x))??0)+1);
    let n=0;
    for(const x of counters[1]) if ((x.responseRef.value!==null)===nonnull && (a.get(key(x))??0)>0) { n++;a.set(key(x),a.get(key(x))!-1); }
    return n;
  }
  expect(matched(true)).toBe(822); expect(matched(false)).toBe(1);
  for(const rs of bySource) {
    const sample=rs.find(x=>x.coordinate.inputLFLine===12)!;
    expect(sample.coordinate.originalLFLine).toBe(17);
    expect(sample.coordinate.recordHash).toBe("UNKNOWN");
    expect(sample.coordinate.decodedOffset).toBe("UNKNOWN");
    expect(sample.presenceBasis).toBe("EXTRACT_ONLY_RAW_PRESENCE_UNRESOLVED");
    expect(rs.every(x=>x.context.owner.id.value===rs[0].context.owner.id.value)).toBe(true);
  }
  // The different archive representation is tested separately; never pretend it is current raw.
  const archived=receipt.archive_version_metadata.map((x:any)=>x.record);
  expect(archived.find((x:any)=>x.line===2).session).not.toBe(receipt.sources[1].owner);
});
