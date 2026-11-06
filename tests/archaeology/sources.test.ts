import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSources } from "../../src/archaeology/sources";
import { manifest, dryRun, sha256, type Inventory } from "../../src/archaeology/pipeline";
test("local source adapter holds repeated tar members; current zstd decoding stays exact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-source-"));
  try {
    mkdirSync(join(dir, "input"));
    const bytes = Buffer.from('{"sessionId":"source-test","type":"user"}\n');
    const file = join(dir, "input", "session.jsonl"), tar = join(dir, "archive.tar.gz"), zst = join(dir, "rollout-session.jsonl.zst");
    writeFileSync(file, bytes);
    expect(Bun.spawnSync(["tar", "-cf", tar, "-C", join(dir, "input"), "session.jsonl"]).exitCode).toBe(0);
    const extra = Buffer.from('{"sessionId":"source-test","type":"assistant"}\n');
    writeFileSync(file, extra); expect(Bun.spawnSync(["tar", "-rf", tar, "-C", join(dir, "input"), "session.jsonl"]).exitCode).toBe(0); writeFileSync(file, bytes);
    // Zstd is optional in CI; tar decoding always runs.
    if (Bun.which("zstd")) expect(Bun.spawnSync(["zstd", "-q", file, "-o", zst]).exitCode).toBe(0);
    const row: Inventory = { machine: "m4", source_kind: "tarball_member", container: tar, member_path: "session.jsonl", session_id: "source-test", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "" };
    const rows = manifest([row, { ...row, sha256: sha256(extra), bytes: String(extra.length) }, ...(Bun.which("zstd") ? [{ ...row, source_kind: "archive_dir", container: "", member_path: zst }] : [])], []);
    const sources = localSources(rows,()=>{throw Error("unknown archive must not be probed");}), result = await dryRun(rows, sources);
    expect(result).toMatchObject({ import_rows:0, needs_fetch:rows.length, sample:[] });
    expect(rows.map(e=>e.sha256).sort()).toEqual([sha256(bytes),sha256(extra),...(Bun.which("zstd")?[sha256(bytes)]:[])].sort());
    expect(rows.every(e=>e.origin==="unknown"&&e.status==="needs_fetch_or_export"&&e.container_hash==="")).toBe(true);
    expect(sources.errors).toEqual([]);
    if (Bun.which("zstd")) {
      // A new current collector fixture, not historical admission of the tar rows.
      const live=manifest([{...row,source_kind:"live",harness:"codex",container:"",member_path:zst}],[],{m4:[dir]});
      const decoder=localSources(live),chunks:Buffer[]=[];
      for await(const e of decoder.order) for await(const chunk of (await decoder.read(e))!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
      expect(live[0].container_hash).toBe(sha256(Buffer.from(await Bun.file(zst).arrayBuffer())));
      expect(decoder.errors).toEqual([]);
    }
    expect(await Bun.file(join(dir, "session.jsonl")).exists()).toBe(false);
  } finally { rmSync(dir, { recursive: true }); }
});

test("S-4 native dataless metadata blocks both hashing and reading a loose zst", async () => {
  const { datalessPaths } = await import("../../src/archaeology/sources");
  const dir=mkdtempSync(join(tmpdir(),"dataless-")),path=join(dir,"rollout-session.jsonl.zst");
  try {
    writeFileSync(path,"must not be decoded");
    expect(datalessPaths([path]).has(path)).toBe(false);
    const row: Inventory={machine:"m4",source_kind:"archive_dir",container:"",member_path:path,session_id:"source-test",harness:"codex",bytes:"19",lines:"1",first_ts:"2026-01-01",last_ts:"2026-01-01",cwd:"/Users/etanheyman/Gits/example",sha256:"",mtime:""};
    const archive=manifest([row],[]),archiveSources=localSources(archive,()=>{throw Error("held archive must not be probed");});
    const archiveReport=await dryRun(archive,archiveSources);
    expect(archiveReport.needs_fetch).toBe(1);expect(archiveReport.read_errors).toBe(0);
    expect(archive[0].origin).toBe("unknown");expect(archive[0].container_hash).toBe("");expect(archiveSources.errors).toEqual([]);
    const entries=manifest([{...row,source_kind:"live"}],[],{m4:[dir]}),probes:string[][]=[];
    const sources=localSources(entries,paths=>{probes.push([...paths]);return new Set([path]);});
    const result=await dryRun(entries,sources);
    expect(probes).toEqual([[path]]);expect(entries[0].origin).toBe("m4");
    expect(result.needs_fetch).toBe(1);expect(result.blocked_live).toBe(1);expect(result.read_errors).toBe(0);
    expect(entries[0].container_hash).toBe("");expect(sources.errors).toEqual([]);
    // Without the dataless refusal this invalid synthetic zstd reaches hashing/decoding.
    const readable=manifest([{...row,source_kind:"live"}],[],{m4:[dir]});
    const readableSources=localSources(readable,()=>new Set()),readableReport=await dryRun(readable,readableSources);
    expect(readable[0].container_hash).not.toBe("");expect(readableReport.read_errors).toBe(1);
  } finally {rmSync(dir,{recursive:true});}
});

test("S-10 a non-hex expected tar member hash is a metadata error, not truncation", async () => {
  const dir=mkdtempSync(join(tmpdir(),"member-hash-")),tar=join(dir,"archive.tar");
  try {
    writeFileSync(tar,"the body must not be parsed");
    const row: Inventory={machine:"m4",source_kind:"tarball_member",container:tar,member_path:"session.jsonl",session_id:"source-test",harness:"claude",bytes:"1",lines:"1",first_ts:"2026-01-01",last_ts:"2026-01-01",cwd:"/Users/etanheyman/Gits/example",sha256:"md5:unknown",mtime:""};
    const entries=manifest([row],[]),sources=localSources(entries),result=await dryRun(entries,sources);
    expect(result.import_rows).toBe(0);expect(entries[0].status).toBe("invalid_member_hash");
    expect(sources.errors[0].reason).toContain("expected member hash must be SHA-256 hex");
    expect(entries[0].container_hash).toBe("");
  } finally {rmSync(dir,{recursive:true});}
});
