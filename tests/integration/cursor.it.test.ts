import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { test } from "../support/clickhouse-gate";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySchema } from "../../src/lib/schema";
import { verifySessionSchema } from "../../src/lib/session-schema";
import { startLocalClickHouse } from "../../src/lib/local-clickhouse";
import { shipOnce } from "../../src/ship/ship";

const USER = "example";

test("Cursor native rows retain SQL NULL after legacy type upgrade and repeat schema apply", async () => {
  const ch = await startLocalClickHouse();
  const dir = mkdtempSync(join(tmpdir(), "cursor-it-"));
  try {
    // Build the actual pre-Cursor schema. ClickHouse 26.12 refuses the reverse
    // nullable -> nonnullable ALTER even on an empty fresh table without a DEFAULT.
    const legacy = readFileSync(join(import.meta.dir, "../../schema/004_session_events.sql"), "utf8")
      .replace("LowCardinality(Nullable(String))", "LowCardinality(String)")
      .replace(/^(    \w+_tokens\s+)Nullable\(UInt64\)/gm, "$1UInt64");
    await ch.client.exec("CREATE DATABASE IF NOT EXISTS tokenlayer");
    await ch.client.exec(legacy.replace(/;\s*$/, ""));
    await expect(verifySessionSchema(ch.client)).rejects.toThrow("schema mismatch");
    await applySchema(ch.client);
    await verifySessionSchema(ch.client);
    const root = join(dir, "projects");
    const folder = join(root, "Users-example-Gits-dialogkit/agent-transcripts/agent-fixture");
    mkdirSync(folder, { recursive: true });
    const raw = readFileSync(join(import.meta.dir, "../fixtures/cursor/native.jsonl"), "utf8");
    writeFileSync(join(folder, "agent-fixture.jsonl"), raw);
    const registry = join(dir, "t3.sqlite"), db = new Database(registry);
    db.run("CREATE TABLE projection_projects (workspace_root TEXT)");
    db.run("INSERT INTO projection_projects VALUES (?)", [`/Users/${USER}/Gits/dialogkit`]);
    db.close();
    const opts = { cursorT3StatePath: registry, machine: "fixture", roots: [{ kind: "cursor" as const, dir: root }], clickhouse: ch.client,
      statePath: join(dir, "state.json"), rateBytesPerSec: 0 };
    expect((await shipOnce(opts)).lines).toBe(2);
    await applySchema(ch.client);
    const rows = await ch.client.queryJSON("SELECT harness, session_id, project, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, raw FROM tokenlayer.session_events FINAL ORDER BY byte_offset");
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.raw).join("")).toBe(raw);
    for (const row of rows) {
      expect(row.harness).toBe("cursor"); expect(row.session_id).toBe("agent-fixture"); expect(row.project).toBe("dialogkit");
      for (const name of ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens"]) expect(row[name]).toBeNull();
    }
    expect((await shipOnce(opts)).lines).toBe(0);
  } finally { await ch.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 40000);
