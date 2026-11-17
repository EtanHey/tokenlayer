import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClickHouse } from "../../src/lib/clickhouse";
import { shipOnce } from "../../src/ship/ship";
import { loadState } from "../../src/ship/state";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("generation rewrite skips old fixture lines, checkpoints skipped bytes, and survives a partial replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retention-")); dirs.push(dir);
  const path = join(dir, "session.jsonl"), statePath = join(dir, "state.json");
  const fixture = readFileSync(join(import.meta.dir, "../fixtures/retention.jsonl"), "utf8");
  const now = Date.now();
  const corpus = fixture.replaceAll("OLD", new Date(now - 40 * 86400000).toISOString())
    .replaceAll("RECENT", new Date(now - 10 * 86400000).toISOString());
  const rows: { raw: string }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    rows.push(...(await req.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    return new Response("");
  } });
  const opts = { machine: "synthetic", roots: [{ kind: "claude" as const, dir }], statePath, rateBytesPerSec: 0,
    clickhouse: new ClickHouse({ url: server.url.toString(), user: "default", password: "", database: "tokenlayer" }) };
  try {
    writeFileSync(path, corpus);
    await shipOnce(opts);
    rows.length = 0;
    writeFileSync(path, corpus.replace("original", "rewritten"));
    await shipOnce({ ...opts, maxLines: 1, batchLines: 1 });
    await shipOnce({ ...opts, batchLines: 1 });
    expect(rows.map(row => JSON.parse(row.raw).sessionId)).toEqual(["recent", "undated", "january"]);
    expect(loadState(statePath).files[path].offset).toBe(statSync(path).size);
    expect((await shipOnce(opts)).lines).toBe(0);
  } finally { server.stop(true); }
});

test("replay retention uses UTC, keeps boundary rows and protects Antigravity", async () => {
  const { retainSessionRow, SESSION_RETENTION_DAYS } = await import("../../src/lib/session-retention");
  const now = Date.parse("2026-11-17T00:00:00Z");
  const cutoff = now - SESSION_RETENTION_DAYS * 86400000;
  const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  expect(retainSessionRow({ harness: "claude", ts: ts(cutoff) }, now)).toBe(true);
  expect(retainSessionRow({ harness: "t3", ts: ts(cutoff - 1) }, now)).toBe(false);
  expect(retainSessionRow({ harness: "antigravity", ts: ts(cutoff - 1) }, now)).toBe(true);
  expect(retainSessionRow({ harness: "claude", ts: ts(0) }, now)).toBe(true);
});

test("replay retention keeps malformed timestamps", async () => {
  const { retainSessionRow } = await import("../../src/lib/session-retention");
  expect(retainSessionRow({ harness: "claude", ts: "malformed" }, Date.now())).toBe(true);
});
