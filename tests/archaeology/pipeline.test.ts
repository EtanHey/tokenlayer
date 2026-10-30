import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, origin, repoMap, manifest, dryRun, sha256, shipperCovers, streamId, parseEvidenceLine, type Inventory } from "../../src/archaeology/pipeline";

const row = (overrides: Partial<Inventory> = {}): Inventory => ({ machine: "M4", source_kind: "archive_dir", container: "", member_path: "/Users/etanheyman/.claude-archive/projects/old/s.jsonl", session_id: "session", harness: "claude", bytes: "1", lines: "1", first_ts: "2026-01-01T00:00:00Z", last_ts: "2026-01-01T00:00:00Z", cwd: "/Users/etanheyman/Desktop/Gits/old/.worktrees/lane", sha256: "", mtime: "", ...overrides });
test("canonical longest copy, prefix skips, renamed repo and unchanged sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archaeology-"));
  try {
    const a = Buffer.from('{ "sessionId":"session", "timestamp":"2026-01-01T00:00:00Z", "type":"user" }\n');
    const b = Buffer.concat([a, Buffer.from('{"sessionId":"session","type":"assistant"}\n')]);
    const paths = [join(dir, "full.jsonl"), join(dir, "prefix.jsonl")];
    paths.forEach((p, i) => writeFileSync(p, i ? a : b));
    const before = paths.map(p => [statSync(p).size, statSync(p).mtimeMs]);
    const copies = paths.map((p, i) => row({ member_path: p, bytes: String(i ? a.length : b.length), sha256: sha256(i ? a : b) }));
    const maps = repoMap(copies, [{ cwd: copies[0].cwd, repo: "EtanHey/new", evidence: "GitHub rename redirect old → new", confidence: "high" }]);
    const entries = manifest(copies, maps);
    const result = await dryRun(entries, { read: async r => (async function* () { yield Buffer.from(await Bun.file(r.member_path).arrayBuffer()); })() });
    expect(result.import_rows).toBe(2);
    expect(result.skip_copy).toBe(1);
    expect(result.import_sessions).toBe(1);
    expect(entries.filter(r => r.selected)).toHaveLength(1);
    expect(entries[1].relation).toBe("prefix");
    expect(result.sample[0].project).toBe("EtanHey/new");
    expect(result.sample[0].raw).toBe(a.toString());
    expect(result.sample[0].content_hash).toBe(sha256(a));
    expect(result.sample[0].generation).toBe(`archive:${sha256(b)}`);
    expect(paths.map(p => [statSync(p).size, statSync(p).mtimeMs])).toEqual(before);
  } finally { rmSync(dir, { recursive: true }); }
});
test("exclude synthetic corpora and telemetry; retain subagents, zst and metadata-only T3", () => {
  for (const p of ["/repo/tests/fixtures/s.jsonl", "/eval-gates/runs/corpus-snapshots/s.jsonl", "/benchmarks/s.jsonl", "/synthetic/home/.claude/projects/s.jsonl", "/registry/events.jsonl"]) expect(classify(row({ member_path: p })).session).toBe(false);
  expect(classify(row({ member_path: "/.claude/projects/x/subagents/agent-a.jsonl" })).session).toBe(true);
  expect(classify(row({ member_path: "/.claude/projects/-Users-etanheyman-Gits-synthetic-incident-fixtures/session.jsonl" })).session).toBe(true);
  expect(classify(row({ harness: "codex", member_path: "/.codex/sessions/rollout-x.jsonl.zst" })).session).toBe(true);
  expect(classify(row({ source_kind: "t3_sqlite", harness: "t3" })).session).toBe(true);
  expect(classify(row({ member_path: "placeholder.tgz", bytes: "40" })).session).toBe(false);
  expect(origin(row({ machine: "drive", cwd: "/Users/happycampr/Gits/x" }))).toBe("m1");
  expect(origin(row({ machine: "drive", cwd: "", member_path: "source-0/s.jsonl" }))).toBe("unknown");
});
test("divergent copies retain unique lines; live pairs skip; unfetched and changed files stay explicit", async () => {
  const a = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const b = Buffer.from('{"sessionId":"session","type":"assistant"}\n');
  const copies = [row({ source_kind: "live", member_path: "/Users/etanheyman/.claude/projects/project/live.jsonl", sha256: sha256(a), bytes: String(a.length) }), row({ member_path: "archive.jsonl", sha256: sha256(b), bytes: String(b.length) }), row({ member_path: "duplicate.jsonl", sha256: sha256(a), bytes: String(a.length) }), row({ member_path: "remote.jsonl", session_id: "remote", source_kind: "drive_file" })];
  const entries = manifest(copies, []);
  const result = await dryRun(entries, { existing: [["m4", "session", copies[0].member_path, sha256(a), 1]], read: async r => r.member_path === "remote.jsonl" ? null : (async function* () { yield r.member_path === "archive.jsonl" ? b : a; })() });
  expect(result.import_rows).toBe(1);
  expect(result.skip_live).toBe(2);
  expect(result.divergent_sessions).toBe(1);
  expect(result.needs_fetch).toBe(1);
  const changed = await dryRun(manifest([row({ sha256: sha256(a), bytes: String(a.length) })], []), { read: async () => (async function* () { yield b; })() });
  expect(changed.import_rows).toBe(0);
  expect(changed.source_changed).toBe(1);
});
test("existing shipper pair export prevents cross-path inserts; invalid UTF-8 fails closed", async () => {
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\r\n');
  const rows = manifest([row({ bytes: String(bytes.length), sha256: sha256(bytes) })], []);
  const report = await dryRun(rows, { existing: [["m4", "session", "session::main", sha256(bytes), 1]], read: async () => (async function* () { yield bytes.subarray(0, 7); yield bytes.subarray(7); })() });
  expect(report.import_rows).toBe(0); expect(report.skip_live).toBe(1);
  const invalid = Buffer.from([0xff, 10]);
  const rejected = await dryRun(manifest([row({ bytes: "2", sha256: sha256(invalid) })], []), { read: async () => (async function* () { yield invalid; })() });
  expect(rejected.read_errors).toBe(1); expect(rejected.import_rows).toBe(0);
});

test("raw preserves a UTF-8 BOM while the hash covers its exact bytes", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"sessionId":"session","type":"user"}\n')]);
  const result = await dryRun(manifest([row({ bytes: String(bytes.length), sha256: sha256(bytes) })], []), { read: async () => (async function* () { yield bytes; })() });
  expect(Buffer.from(result.sample[0].raw).equals(bytes)).toBe(true);
  expect(sha256(Buffer.from(result.sample[0].raw))).toBe(result.sample[0].content_hash);
});


test("MF-1 compressed rollouts outside shipper roots remain historical", async () => {
  const path = "/history/2026/01/01/rollout-session.jsonl.zst";
  const bytes = Buffer.from('{"type":"session_meta","payload":{"id":"session"}}\n');
  const compressedHash = sha256(Buffer.from("compressed-container-fixture"));
  const entries = manifest([row({ source_kind: "live", harness: "codex", member_path: path, bytes: String(bytes.length), sha256: sha256(bytes) })], []);
  entries[0].container_hash = compressedHash;
  const result = await dryRun(entries, { read: async () => (async function* () { yield bytes; })() });
  expect(shipperCovers(path,"m4")).toBe(false);
  expect(shipperCovers(path.replace(/\.zst$/, ""),"m4")).toBe(false);
  expect(result.live_rows).toBe(0); expect(result.import_rows).toBe(1);
  expect(result.sample[0].path).toBe(`archive://${compressedHash}/${path}`);
});

test("S-8 a failed second read cannot relabel an earlier verified prefix", async () => {
  const a = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const b = Buffer.concat([a, Buffer.from('{"sessionId":"session","type":"assistant"}\n')]);
  const entries = manifest([row({ member_path:"prefix.jsonl",bytes:String(a.length),sha256:sha256(a) }),row({member_path:"full.jsonl",bytes:String(b.length),sha256:sha256(b)})],[]);
  const prefix=entries.find(e=>e.member_path==="prefix.jsonl")!;const full=entries.find(e=>e.member_path==="full.jsonl")!;let reads=0;
  const result=await dryRun(entries,{order:(async function*(){yield prefix;yield full;})(),read:async e=>(async function*(){yield e===prefix?a:++reads===1?b:a;})()});
  expect(result.read_errors).toBe(1);expect(result.import_rows).toBe(1);
  expect(prefix.relation).toBe("canonical_verified");expect(full.relation).toBe("unverified");
});


test("MF-2 missing repeated occurrences survive per stream and retain reconstruction offsets", async () => {
  const header=Buffer.from('{"sessionId":"session","type":"user"}\n');const repeated=Buffer.from('{"type":"mode","mode":"A"}\n');
  const prefix=Buffer.concat([header,repeated]),full=Buffer.concat([header,repeated,repeated,repeated]);
  const data=new Map([["/Users/etanheyman/.claude/projects/p/session.jsonl",prefix],["full.jsonl",full],["session/subagents/agent-a.jsonl",prefix],["copy/session/subagents/agent-a.jsonl",prefix]]);
  const entries=manifest([...data].map(([path,bytes],i)=>row({member_path:path,source_kind:i===0?"live":"archive_dir",bytes:String(bytes.length),sha256:sha256(bytes)})),[]);
  const result=await dryRun(entries,{existing:[["m4","session",[...data.keys()][0],sha256(header),1],["m4","session",[...data.keys()][0],sha256(repeated),1]],read:async e=>(async function*(){yield data.get(e.member_path)!;})()});
  const main=result.sample.filter(e=>streamId(e.session_id,e.path)===streamId("session","full.jsonl"));
  expect(main.map(e=>e.byte_offset)).toEqual([prefix.length,prefix.length+repeated.length]);
  expect(Buffer.concat([prefix,...main.sort((a,b)=>a.byte_offset-b.byte_offset).map(e=>Buffer.from(e.raw))]).equals(full)).toBe(true);
  expect(result.import_rows).toBe(4);expect(result.skip_live).toBe(4);expect(result.skip_copy).toBe(2);
  expect(result.divergent_sessions).toBe(0);
  const seeded=await dryRun(manifest([row({bytes:String(full.length),sha256:sha256(full),member_path:"full.jsonl"})],[]),{existing:[["m4","session","full.jsonl",sha256(header),1],["m4","session","full.jsonl",sha256(repeated),1]],read:async()=>(async function*(){yield full;})()});
  expect(seeded.import_rows).toBe(2);expect(seeded.skip_live).toBe(2);
});

test("MF-3 findings and Cursor fixtures fail path and verified-content gates", async () => {
  const finding=Buffer.from('{"id":"finding","title":"fixture","type":"anti-pattern"}\n');
  const cursor=Buffer.from('{"role":"user","message":{"content":"fixture"}}\n');
  const badCodex=Buffer.from('{"type":"session_meta","payload":{"id":"other"}}\n');
  expect(classify(row({member_path:"/weave/findings/session.jsonl"})).session).toBe(false);
  expect(classify(row({member_path:"source-4/Users-etanheyman-Gits-p/agent-transcripts/id/id.jsonl"})).session).toBe(false);
  const data=new Map([["finding-copy.jsonl",finding],["cursor-copy.jsonl",cursor],["rollout-other.jsonl",badCodex]]);
  const entries=manifest([...data].map(([path,bytes])=>row({member_path:path,harness:path.startsWith("rollout-")?"codex":"claude",bytes:String(bytes.length),sha256:sha256(bytes)})),[]);
  const result=await dryRun(entries,{read:async e=>(async function*(){yield data.get(e.member_path)!;})()});
  expect(result.import_rows).toBe(0);expect(result.not_transcript).toBe(3);
  expect(entries.every(e=>e.status==="not_transcript"&&!e.selected)).toBe(true);
});


test("S-3 dated machine evidence splits reused directories and current mappings remain open", () => {
  const cwd="/workspace/reused";
  const evidence=[parseEvidenceLine(JSON.stringify({machine:"m4",cwd,repo:"Owner/old",evidence:"old remote",confidence:"high",valid_from:"2025-01-01",valid_to:"2026-01-01"})),parseEvidenceLine(JSON.stringify({machine:"m4",cwd,repo:"Owner/current",evidence:"current remote",confidence:"high",valid_from:"2026-01-01",valid_to:null})),parseEvidenceLine(JSON.stringify({machine:"m1",cwd,repo:"Other/repo",evidence:"other machine",confidence:"high",valid_from:null,valid_to:null}))];
  expect(evidence[1].machine).toBe("m4");expect(evidence[1].valid_to).toBe(null);
  const rows=[row({cwd,first_ts:"2025-06-01",last_ts:"2025-06-01",member_path:"old.jsonl"}),row({cwd,first_ts:"2027-06-01",last_ts:"2027-06-01",member_path:"new.jsonl"})];
  const maps=repoMap(rows,evidence),entries=manifest(rows,maps);
  expect(maps.filter(m=>m.repo_canonical)).toHaveLength(2);
  expect(maps.find(m=>m.repo_canonical==="Owner/current")?.valid_to).toBe(null);
  expect(entries.find(e=>e.member_path==="old.jsonl")?.repo).toBe("Owner/old");
  expect(entries.find(e=>e.member_path==="new.jsonl")?.repo).toBe("Owner/current");
});

test("MF-3 a generic session_id field cannot impersonate Claude sessionId", async () => {
  const bytes=Buffer.from('{"session_id":"session","type":"anti-pattern","title":"fixture"}\n');
  const result=await dryRun(manifest([row({member_path:"notes.jsonl",bytes:String(bytes.length),sha256:sha256(bytes)})],[]),{read:async()=>(async function*(){yield bytes;})()});
  expect(result.import_rows).toBe(0);expect(result.not_transcript).toBe(1);
});

test("MF-3 Codex native header id is authoritative over parser session_id aliases", async () => {
  const bytes=Buffer.from('{"type":"session_meta","payload":{"id":"session","session_id":"older-parent"}}\n{"type":"event_msg","payload":{"type":"fixture"}}\n');
  const entries=manifest([row({harness:"codex",member_path:"rollout-session.jsonl",bytes:String(bytes.length),sha256:sha256(bytes)})],[]);
  const result=await dryRun(entries,{read:async()=>(async function*(){yield bytes;})()});
  expect(result.import_rows).toBe(2);expect(result.not_transcript).toBe(0);
  expect(result.sample.every(e=>e.session_id==="session")).toBe(true);
  expect(Buffer.concat(result.sample.map(e=>Buffer.from(e.raw))).equals(bytes)).toBe(true);
});

test("NF-1 native child rollout stream is accepted and isolated from its parent alias", async () => {
  const parent="11111111-1111-4111-8111-111111111111",child="22222222-2222-4222-8222-222222222222";
  const common='{"type":"event_msg","payload":{"type":"fixture"}}\n';
  const parentBytes=Buffer.from(JSON.stringify({type:"session_meta",payload:{id:parent}})+'\n'+common);
  const childBytes=Buffer.from(JSON.stringify({type:"session_meta",payload:{id:child,session_id:parent}})+'\n'+common);
  const path=`/Users/etanheyman/.codex/sessions/rollout-2026-01-01T00-00-00-${child}.jsonl.zst`;
  const data=new Map([[`rollout-${parent}.jsonl`,parentBytes],[path,childBytes],[`copy/rollout-${child}.jsonl.zst`,childBytes]]);
  const rows=[...data].map(([member_path,bytes],i)=>row({harness:"codex",session_id:i===2?child:parent,member_path,bytes:String(bytes.length),sha256:sha256(bytes)}));
  const entries=manifest(rows,[]),read=async(e:{member_path:string})=>(async function*(){yield data.get(e.member_path)!;})();
  const result=await dryRun(entries,{read});
  expect(result.import_rows).toBe(4);expect(result.skip_copy).toBe(2);expect(result.not_transcript).toBe(0);
  expect(entries.filter(e=>e.member_path.includes(child)).every(e=>e.stream===`${child}::main`)).toBe(true);
  expect(result.sample.filter(e=>e.path.includes(child)).every(e=>e.session_id===child)).toBe(true);
  expect(result.sample.filter(e=>!e.path.includes(child)).every(e=>e.session_id===parent)).toBe(true);
  const seeded=await dryRun(manifest([rows[1]],[]),{read,existing:[["m4",parent,path,sha256(childBytes.subarray(0,childBytes.indexOf(10)+1)),1],["m4",parent,path,sha256(Buffer.from(common)),1]]});
  expect(seeded.import_rows).toBe(0);expect(seeded.skip_live).toBe(2);
});

test("NF-2 Claude positive native identity retains all carried-over foreign lines", async () => {
  const own='{"sessionId":"A","type":"user"}\n',foreign='{"sessionId":"B","type":"assistant"}\n';
  const bytes=Buffer.from(own.repeat(1000)+foreign);
  const entries=manifest([row({session_id:"A",member_path:"A.jsonl",bytes:String(bytes.length),sha256:sha256(bytes)})],[]);
  const result=await dryRun(entries,{sampleSize:1001,read:async()=>(async function*(){yield bytes;})()});
  expect(result.import_rows).toBe(1001);expect(result.not_transcript).toBe(0);
  expect(result.sample.every(e=>e.session_id==="A")).toBe(true);
  expect(Buffer.concat(result.sample.map(e=>Buffer.from(e.raw))).equals(bytes)).toBe(true);
});

test("F-5 generated Antigravity logs and workflow findings are excluded by layout", () => {
  expect(classify(row({source_kind:"drive_tarball_member",member_path:"source-10/11111111-1111-4111-8111-111111111111/.system_generated/logs/transcript_full.jsonl"})).session).toBe(false);
  expect(classify(row({member_path:"session/subagents/workflows/lane/findings/result.jsonl"})).session).toBe(false);
  expect(classify(row({member_path:"session/subagents/workflows/lane/agent-a.jsonl"})).session).toBe(true);
});

test("F-8 live coverage uses explicit machine roots independent of the M4 environment", () => {
  const prior=process.env.TOKENLAYER_CLAUDE_DIR;process.env.TOKENLAYER_CLAUDE_DIR="/Users/etanheyman/custom-claude";
  try {
    const path="/Users/happycampr/.claude/projects/p/session.jsonl";
    expect(shipperCovers(path,"m1")).toBe(true);
    expect(shipperCovers(path,"m4")).toBe(false);
    const roots={m1:["/Users/happycampr/custom-claude"],m4:["/Users/etanheyman/custom-claude"]};
    expect(shipperCovers(path,"m1",roots)).toBe(false);
    expect(shipperCovers("/Users/happycampr/custom-claude/p/session.jsonl","m1",roots)).toBe(true);
    const entry=row({machine:"m1",cwd:"/Users/happycampr/Gits/p",source_kind:"live",member_path:path});
    expect(manifest([entry],[])[0].source_kind).toBe("live");
    expect(manifest([entry],[],roots)[0].source_kind).toBe("archive_dir");
  } finally {if(prior===undefined)delete process.env.TOKENLAYER_CLAUDE_DIR;else process.env.TOKENLAYER_CLAUDE_DIR=prior;}
});
