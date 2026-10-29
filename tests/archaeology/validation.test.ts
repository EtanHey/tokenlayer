import { test, expect } from "bun:test";
import { clickhouseBinary } from "../../src/lib/local-clickhouse";
import { manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { validatedDryRun } from "../../src/archaeology/validation";

test.skipIf(!clickhouseBinary())("S-5 dry-run leaves a preseeded real ClickHouse baseline unchanged", async () => {
  const bytes=Buffer.from('{"sessionId":"validation-fixture","type":"user"}\n');
  const row: Inventory={machine:"m4",source_kind:"archive_dir",container:"",member_path:"validation.jsonl",session_id:"validation-fixture",harness:"claude",bytes:String(bytes.length),lines:"1",first_ts:"2026-01-01",last_ts:"2026-01-01",cwd:"/Users/etanheyman/Gits/example",sha256:sha256(bytes),mtime:""};
  const result=await validatedDryRun(manifest([row],[]),{read:async()=>(async function*(){yield bytes;})()},3);
  expect(result.baseline).toEqual({seed_rows:3,before:3,after:3,after_sample:3});
  expect(result.report.import_rows).toBe(1);expect(result.validated).toBe(1);
});
