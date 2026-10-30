import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { applySchema } from "../../src/lib/schema";
import { shipOnce } from "../../src/ship/ship";

test("real FINAL: plain → zst → replay preserves events, sessions and every raw byte", async () => {
  const ch = await startLocalClickHouse();
  const scratch = join(import.meta.dir, "../../.local"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "zst-it-")), path = join(dir,"rollout.jsonl");
  const bytes = Buffer.from([
    JSON.stringify({type:"session_meta",timestamp:"2026-10-29T00:00:00Z",payload:{id:"child",session_id:"parent",originator:"T3 Code"}}),
    JSON.stringify({type:"turn_context",timestamp:"2026-10-29T00:00:01Z",payload:{model:"fixture"}}),
  ].join("\r\n")+"\r\n");
  const opts = { machine:"m4", roots:[{kind:"codex" as const,dir}], statePath:join(dir,"state"),clickhouse:ch.client,rateBytesPerSec:0,batchBytes:64 };
  try {
    await applySchema(ch.client);writeFileSync(path,bytes);expect((await shipOnce(opts)).lines).toBe(2);
    const counts = () => ch.client.queryJSON("SELECT count() AS events, uniqExact(session_id) AS sessions FROM tokenlayer.session_events FINAL");
    const before = await counts();
    writeFileSync(path+".zst",Bun.zstdCompressSync(bytes));unlinkSync(path);unlinkSync(opts.statePath);
    // Force actual compressed replay via retained journal, rather than a zero-line shortcut.
    expect((await shipOnce(opts)).lines).toBe(2);expect(await counts()).toEqual(before);
    expect((await shipOnce(opts)).lines).toBe(0);
    const cliDir=join(dir,"cli");mkdirSync(cliDir);
    const cliFile=join(cliDir,"old.jsonl.zst");writeFileSync(cliFile,Bun.zstdCompressSync(bytes));
    utimesSync(cliFile,new Date("2026-10-01"),new Date("2026-10-01"));
    const runCli=async(since:string)=>{
      const proc=Bun.spawn([process.execPath,join(import.meta.dir,"../../src/ship/main.ts"),"--backfill","--since",since,"--rate-mb","0"],{env:{
        PATH:process.env.PATH,HOME:dir,TOKENLAYER_ENV_FILES:join(dir,"missing.env"),TOKENLAYER_MACHINE:"cli-fixture",
        TOKENLAYER_CODEX_DIR:cliDir,TOKENLAYER_CLAUDE_DIR:join(dir,"empty"),TOKENLAYER_SHIP_STATE:join(dir,"cli.state"),
        CLICKHOUSE_URL:ch.client.config.url,CLICKHOUSE_USER:"default",CLICKHOUSE_PASSWORD:"",CLICKHOUSE_DB:"tokenlayer",
      },stdout:"pipe",stderr:"pipe"});
      const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();
      expect(error).toBe("");expect(await proc.exited).toBe(0);return output;
    };
    expect(await runCli("2026-10-02")).toBe("");
    expect(await runCli("2026-09-30")).toContain("lines=2");
    const rows = await ch.client.queryJSON<{raw_hex:string;generation:string;session_id:string;session_alias:string}>("SELECT hex(raw) AS raw_hex,generation,session_id,session_alias FROM tokenlayer.session_events FINAL WHERE machine='m4' ORDER BY byte_offset");
    expect(Buffer.concat(rows.map(r=>Buffer.from(r.raw_hex,"hex")))).toEqual(bytes);
    expect(rows[0]).toMatchObject({session_id:"child",session_alias:"parent"});
  } finally { await ch.stop(); }
}, 40000);
