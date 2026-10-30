import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dryRun, manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { clickhouseBinary, startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { applySchema } from "../../src/lib/schema";
import { shipOnce } from "../../src/ship/ship";

const scratch = () => { mkdirSync(".local", { recursive: true }); return realpathSync(mkdtempSync(".local/archaeology-blockers-")); };
const row = (member_path: string, bytes: Buffer, overrides: Partial<Inventory> = {}): Inventory => ({ machine: "m4", source_kind: "live", container: "", member_path, session_id: "session", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "", ...overrides });
const read = (bytes: Buffer) => async () => (async function* () { yield bytes; })();

test.skipIf(!clickhouseBinary())("SHOULD-2 old live file requires shipper backfill and a server export", async () => {
  const dir = scratch(), path = join(dir, "session.jsonl"), bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  writeFileSync(path, bytes); utimesSync(path, new Date("2026-01-01"), new Date("2026-01-01"));
  const local = await startLocalClickHouse();
  try {
    await applySchema(local.client);
    const opts = { machine: "m4", roots: [{ kind: "claude" as const, dir }], statePath: join(dir, "state"), clickhouse: local.client, rateBytesPerSec: 0 };
    expect((await shipOnce({ ...opts, sinceMs: Date.now() - 24 * 60 * 60 * 1000 })).lines).toBe(0);
    const copies = [row(path, bytes), row(join(dir, "copy.jsonl"), bytes, { source_kind: "archive_dir" })];
    const entries = () => manifest(copies, [], { m4: [dir] });
    const missing = await dryRun(entries(), { existing: [], read: read(bytes) });
    expect(missing.import_rows).toBe(0); expect(missing.skip_live).toBe(0); expect(missing.needs_shipper_backfill).toBe(1); expect(missing.skip_shipper).toBe(1);
    expect((await shipOnce(opts)).lines).toBe(1);
    const stored = await local.client.queryJSON<{ machine: string; session_id: string; path: string; content_hash: string; count: number }>("SELECT machine,session_id,path,content_hash,toUInt32(count()) AS count FROM tokenlayer.session_events FINAL GROUP BY machine,session_id,path,generation,content_hash");
    const existing = stored.map(r => [r.machine, r.session_id, r.path, r.content_hash, r.count] satisfies import("../../src/archaeology/pipeline").ExistingCount);
    expect((await dryRun(entries(), { existing, read: read(bytes) })).import_rows).toBe(0);
    expect((await dryRun(entries(), { existing: existing.map(([,session,path,hash,count]) => ["m1", session, path, hash, count]), read: read(bytes) })).needs_shipper_backfill).toBe(1);
  } finally { await local.stop(); }
}, 40_000);

for (const scenario of ["LF blanks", "BOM"] as const) test.skipIf(!clickhouseBinary())(`NIT-2/NIT-3 shipper and archaeology agree on ${scenario}, CRLF columns and exact bytes`, async () => {
  const dir = scratch(), path = join(dir, "session.jsonl");
  const bytes = Buffer.from((scenario==="BOM"?"\ufeff":"")+'{"sessionId":"session","type":"user"}\n'+(scenario==="LF blanks"?"\n":"")+'{"sessionId":"session","type":"assistant"}\r\n\r\n \n');
  writeFileSync(path, bytes);
  const local = await startLocalClickHouse();
  try {
    await applySchema(local.client);
    await shipOnce({ machine: "m4", roots: [{ kind: "claude", dir }], statePath: join(dir, "state"), clickhouse: local.client, rateBytesPerSec: 0 });
    const report = await dryRun(manifest([row(path, bytes, { source_kind: "archive_dir" })], []), { read: read(bytes) });
    expect(report.import_rows).toBe(4);
    const fields = "ts,session_id,session_alias,project,cwd,type,role,model,message_id,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reasoning_tokens,raw,byte_offset,content_hash,line_bytes";
    const stored = await local.client.queryJSON(`SELECT ${fields} FROM tokenlayer.session_events FINAL ORDER BY byte_offset`);
    expect(report.sample.map(r => Object.fromEntries(fields.split(",").map(k => [k, Reflect.get(r, k)])))).toEqual(stored);
    if(scenario==="BOM"){expect(report.sample[0].type).toBe("invalid");expect(Buffer.from(report.sample[0].raw).subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));}
    expect(report.sample.every(r => sha256(Buffer.from(r.raw)) === r.content_hash)).toBe(true);
  } finally { await local.stop(); }
}, 40_000);
