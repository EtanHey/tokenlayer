import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { shipOnce } from "../../src/ship/ship";
import { drainOnce } from "../../src/drain/drain";
import { Spool } from "../../src/drain/spool";
import { redactText } from "../../src/lib/redact";
import { clickhouseBinary, startLocalClickHouse } from "../support/local-clickhouse";

const root = join(import.meta.dir, "../../.local");
const stamp = { timestamp: "2026-10-28T08:00:00Z" };
const tokenCount = { ...stamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { output_tokens: 230 }, last_token_usage: { output_tokens: 230 } } } };

for (const kind of ["codex", "claude"] as const) test.skipIf(!clickhouseBinary())(`review: returning ${kind} inode preserves every parsed column`, async () => {
  const ch = await startLocalClickHouse();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "pure-lines-"));
  try {
    await applySchema(ch.client);
      const folder = join(dir, kind);
      mkdirSync(folder);
      const file = join(folder, "session.jsonl");
      const opts = { machine: kind, roots: [{ kind, dir: folder }], statePath: join(dir, `${kind}.state`), clickhouse: ch.client, rateBytesPerSec: 0 };
      const source = (prefix: string) => (kind === "codex" ? [
        { ...stamp, type: "session_meta", payload: { id: "session", cwd: "/x/repo" } },
        { ...stamp, type: "turn_context", payload: { model: prefix } },
        { ...stamp, type: "response_item", payload: { role: "assistant" } },
        tokenCount, { ...stamp, type: "event_msg", payload: { type: "other" } }, tokenCount,
      ] : [{ entrypoint: prefix === 'msg_a' ? 'sdk-ts' : 'cli-ts' }, ...[prefix, "msg_b"].map(id => ({ ...stamp, sessionId: "session", type: "assistant", message: { id, usage: { input_tokens: 10, output_tokens: 20 } } }))])
        .map(row => JSON.stringify(row)).join("\n") + "\n";
      const snapshot = () => ch.client.queryJSON<Record<string, unknown>>(`SELECT * EXCEPT ingested_at FROM tokenlayer.session_events FINAL WHERE machine='${kind}'`);
      writeFileSync(file, source(kind === "codex" ? "model-A" : "msg_a"));
      const inode = statSync(file).ino;
      await shipOnce(opts);
      const archived = await snapshot();
      if (kind === "codex") {
        const [derived] = await ch.client.queryJSON<{ model: string; session_id: string; ordinal: string }>("SELECT model,session_id,ordinal FROM tokenlayer.v_session_events_context WHERE machine='codex' AND type='response_item'");
        expect(derived).toMatchObject({ model: "model-A", session_id: "session" });
        expect(Number(derived.ordinal)).toBe(3);
        expect(Number((await ch.client.queryJSON<{ n: string }>("SELECT sum(output_tokens) AS n FROM tokenlayer.v_session_events_context WHERE machine='codex'"))[0].n)).toBe(230);
        expect(archived.reduce((sum, row) => sum + Number(row.output_tokens), 0)).toBe(460);
      }
      writeFileSync(file, source(kind === "codex" ? "model-B" : "msg_b"));
      await shipOnce(opts);
      renameSync(file, `${file}.parked`);
      writeFileSync(file, source(kind === "codex" ? "model-C" : "msg_c"));
      await shipOnce(opts);
      renameSync(file, `${file}.replacement`);
      renameSync(`${file}.parked`, file);
      expect(statSync(file).ino).toBe(inode);
      await shipOnce(opts);
      const current = await snapshot();
      for (const row of archived) expect(current).toContainEqual(row);
  } finally { await ch.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 40_000);

test.skipIf(!clickhouseBinary())('stack review: drain callback and real binary retain safe insert diagnostics', async () => {
  const ch = await startLocalClickHouse();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'drain-error-'));
  const secret = 'sk-ant-api03-SYNTHETICfake' + 'A'.repeat(40);
  const item = { ...stamp, failed: true, fail: { body: JSON.stringify({ error: `upstream said:\n${secret}` }) } };
  const hub = Bun.serve({ port: 0, fetch: () => Response.json([item]) });
  try {
    await applySchema(ch.client);
    await ch.client.exec('ALTER TABLE tokenlayer.proxy_usage MODIFY COLUMN fail_body UInt8');
    let message = '';
    const result = await drainOnce({ hubUrl: hub.url.href, mgmtKey: 'synthetic-management', hub: 'm1', clickhouse: ch.client, spool: new Spool(join(dir, 'callback')), onInsertError: e => { message = redactText(e instanceof Error ? e.message : String(e)); } });
    expect(result.spooled).toBe(1);
    const proc = Bun.spawn([process.execPath, 'src/drain/main.ts', '--once'], { cwd: join(import.meta.dir, '../..'), env: { PATH: process.env.PATH, TOKENLAYER_ENV_FILES: '/dev/null', CLIPROXY_MGMT_KEY: 'synthetic-management', TOKENLAYER_HUB: 'm1', TOKENLAYER_HUB_URL: hub.url.href, TOKENLAYER_STATE_DIR: join(dir, 'binary'), CLICKHOUSE_URL: ch.client.config.url }, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(message).toContain('clickhouse insert into proxy_usage failed: HTTP 400 exception 27');
    expect(message).not.toContain(secret);
    expect(message).toContain('[redacted]');
    expect(stderr).toBe(`tokenlayer-drain: insert failed, spooled: ${message}\n`);
    expect(stderr).not.toContain(secret);
  } finally { hub.stop(true); await ch.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 40_000);

for (const version of ["legacy", "generation"]) for (const variant of [false, true]) test.skipIf(!clickhouseBinary())(`review: ${version} late harness migration, content variant=${variant}`, async () => {
  const ch = await startLocalClickHouse();
  try {
    await ch.client.exec("CREATE DATABASE tokenlayer");
    const old = version === "legacy"
      ? "CREATE TABLE tokenlayer.session_events (machine String,harness String,path String,byte_offset UInt64,ts DateTime64(3),raw String) ENGINE=ReplacingMergeTree ORDER BY (machine,path,byte_offset)"
      : readFileSync(join(import.meta.dir, "../../schema/004_session_events.sql"), "utf8").replace(/^    content_hash.*\n/m, "")
        .replace("ORDER BY (machine, path, generation, byte_offset, content_hash)", "ORDER BY (machine, path, generation, byte_offset)").replace(/;\s*$/, "");
    await ch.client.exec(old);
    await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events");
    const rows = [0, 8].map(byte_offset => ({ machine: "m", harness: "claude", path: "/p", byte_offset, ts: "2026-10-28 08:00:00.000", raw: JSON.stringify({ a: byte_offset }) }));
    await ch.client.insert("session_events", rows);
    await ch.client.insert("session_events", rows.map(row => ({ ...row, harness: "t3", raw: variant && row.byte_offset === 0 ? "{\"changed\":true}" : row.raw })));
    const count = () => ch.client.queryJSON<{ n: string }>("SELECT count() AS n FROM tokenlayer.session_events FINAL");
    expect(Number((await count())[0].n)).toBe(2);
    expect(await ch.client.queryJSON("SELECT DISTINCT harness FROM tokenlayer.session_events FINAL")).toEqual([{ harness: "t3" }]);
    if (version === "legacy" && !variant) {
      await ch.client.exec("CREATE TABLE tokenlayer.session_events_hash_next (raw String) ENGINE=MergeTree ORDER BY tuple()");
      await expect(applySchema(ch.client)).rejects.toThrow("session_events_hash_next already exists");
      await ch.client.exec("DROP TABLE tokenlayer.session_events_hash_next");
    }
    await applySchema(ch.client);
    expect(Number((await count())[0].n)).toBe(variant ? 3 : 2);
    if (!variant) expect(await ch.client.queryJSON("SELECT DISTINCT harness FROM tokenlayer.session_events FINAL")).toEqual([{ harness: "t3" }]);
    const columns = await ch.client.queryJSON<{ name: string }>("DESCRIBE TABLE tokenlayer.v_session_events_meta");
    expect(columns.map(c => c.name)).toContain("generation");
    expect(columns.map(c => c.name)).toContain("content_hash");
    expect(columns.map(c => c.name)).not.toContain("raw");
    await applySchema(ch.client);
    expect(Number((await count())[0].n)).toBe(variant ? 3 : 2);
  } finally { await ch.stop(); }
}, 40_000);

for (const escaped of [false, true]) test.skipIf(!clickhouseBinary())(`review: real raw parse-error echoes redact AggregateError entries, newline=${escaped}`, async () => {
  const ch = await startLocalClickHouse();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "raw-error-"));
  try {
    await applySchema(ch.client);
    await ch.client.exec("ALTER TABLE tokenlayer.session_events MODIFY COLUMN raw UInt8");
    const secret = "sk-ant-api03-SYNTHETICfake" + "A".repeat(40);
    writeFileSync(join(dir, "secret.jsonl"), JSON.stringify(escaped ? { type: 'user', message: { role: 'user', content: `see:\n${secret}` } } : { secret }) + "\n");
    const error: unknown = await shipOnce({ machine: "synthetic", roots: [{ kind: "claude", dir }], statePath: join(dir, "state"), clickhouse: ch.client, rateBytesPerSec: 0 }).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("expected aggregate");
    expect(error.errors).toHaveLength(1);
    for (const entry of error.errors) {
      expect(entry).toBeInstanceOf(Error);
      if (!(entry instanceof Error)) throw new Error("expected Error entry");
      expect(entry.message).toContain("clickhouse insert");
      expect(entry.message).toContain("[redacted]");
      expect(entry.message).not.toContain(secret);
      expect(entry.message).not.toContain("SYNTHETICfake");
    }
    // Keep the real CLI schema preflight intact, then force an insert failure with a constraint.
    await ch.client.exec('ALTER TABLE tokenlayer.session_events MODIFY COLUMN raw String');
    await ch.client.exec('ALTER TABLE tokenlayer.session_events ADD CONSTRAINT egress_probe CHECK length(raw) = 0');
    const proc = Bun.spawn([process.execPath, 'src/ship/main.ts', '--backfill'], { cwd: join(import.meta.dir, '../..'), env: { PATH: process.env.PATH, TOKENLAYER_ENV_FILES: '/dev/null', TOKENLAYER_MACHINE: 'm4', TOKENLAYER_CLAUDE_DIR: dir, TOKENLAYER_CODEX_DIR: join(dir, 'absent'), TOKENLAYER_SHIP_STATE: join(dir, 'cli-state'), CLICKHOUSE_URL: ch.client.config.url }, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('clickhouse insert into session_events failed');
    expect(stderr).not.toContain(secret);
  } finally { await ch.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 40_000);
