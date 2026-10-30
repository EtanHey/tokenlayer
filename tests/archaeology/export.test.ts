import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dryRun, manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { readExisting } from "../../src/archaeology/main";
import { clickhouseBinary, startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { applySchema } from "../../src/lib/schema";
import { shipOnce } from "../../src/ship/ship";

test.skipIf(!clickhouseBinary())("SHOULD-B canonical CLI export covers empty session ids, subagents and generations", async () => {
  mkdirSync(".local", { recursive: true });
  const dir = realpathSync(mkdtempSync(".local/existing-export-")), sessions = join(dir, "sessions"), parent = "11111111-1111-4111-8111-111111111111";
  const agent = join(sessions, parent, "subagents", "agent-a.jsonl"), main = join(sessions, `${parent}.jsonl`);
  mkdirSync(join(sessions, parent, "subagents"), { recursive: true });
  const marker = Buffer.from('{"type":"mode"}\n');
  const mainBytes = Buffer.concat([Buffer.from(`{"sessionId":"${parent}","type":"user"}\n`), marker]);
  writeFileSync(main, mainBytes); writeFileSync(agent, Buffer.concat([marker, marker]));
  const local = await startLocalClickHouse();
  const exportFile = async (name: string) => {
    const path = join(dir, name);
    const proc = Bun.spawn([process.execPath, "src/archaeology/main.ts", "export-existing", "--out", path], { env: { ...process.env, CLICKHOUSE_URL: local.client.config.url, CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "", CLICKHOUSE_DB: "tokenlayer", USER: "fixture" }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    return path;
  };
  try {
    await applySchema(local.client);
    expect(readExisting(await exportFile("empty.tsv"))).toEqual([]);
    await shipOnce({ machine: "m4", roots: [{ kind: "claude", dir: sessions }], statePath: join(dir, "state"), clickhouse: local.client, rateBytesPerSec: 0 });
    // Two generations must retain their own maxima rather than sum coverage.
    await local.client.exec("INSERT INTO tokenlayer.session_events SELECT * REPLACE('second' AS generation) FROM tokenlayer.session_events FINAL");
    const path = await exportFile("existing.tsv"), existing = readExisting(path);
    expect(readFileSync(path, "utf8")).toContain("machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount");
    expect(existing.filter(r => r[2] === agent)).toHaveLength(2);
    expect(existing.filter(r => r[2] === agent).every(r => r[1] === parent && r[4] === 2)).toBe(true);
    const row: Inventory = { machine: "m4", source_kind: "archive_dir", container: "", member_path: `copy/${parent}/subagents/agent-a.jsonl`, session_id: parent, harness: "claude", bytes: String(marker.length * 3), lines: "3", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(Buffer.concat([marker, marker, marker])), mtime: "" };
    const report = await dryRun(manifest([row], []), { existing, read: async () => (async function* () { yield Buffer.concat([marker, marker, marker]); })() });
    expect(report.skip_live).toBe(2); expect(report.import_rows).toBe(1);
    expect((await local.client.exec("SELECT count() FROM tokenlayer.session_events FINAL WHERE session_id='' ")).trim()).toBe("6");
  } finally { await local.stop(); }
}, 40_000);
