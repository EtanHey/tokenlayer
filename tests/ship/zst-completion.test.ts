import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClickHouse, RAW_BYTES } from "../../src/lib/clickhouse";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";
import { loadState } from "../../src/ship/state";
import { compressedHash, inspectZstd, spawnZstd } from "../../src/ship/zst";

const scratch = process.env.TOKENLAYER_TEST_SCRATCH ?? join(import.meta.dir, "../../.local");
mkdirSync(scratch, { recursive: true });
const meta = Buffer.from(JSON.stringify({ type: "session_meta", payload: {
  id: "owned-session", originator: "T3 Code", cwd: "/fixture/repo",
} }) + "\r\n");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(bytes: Buffer) {
  const dir = mkdtempSync(join(scratch, "zst-completion-"));
  const physical = join(dir, "rollout.jsonl.zst"), logical = physical.slice(0, -4);
  writeFileSync(physical, Bun.zstdCompressSync(bytes));
  const rows: Record<string | symbol, unknown>[] = [], tokens: (string | undefined)[] = [];
  // Only the insert acknowledgement is synthetic; all decoding/checkpoint code is real.
  const client = new ClickHouse({ url: "http://fixture.invalid", user: "", password: "", database: "tokenlayer" });
  client.insert = async (table, batch, token) => {
    expect(table).toBe("session_events");
    rows.push(...batch as typeof rows); tokens.push(token);
  };
  const calls = { reads: 0, spawns: 0 };
  const opts: ShipOptions = {
    machine: "owned-fixture", roots: [{ kind: "codex", dir }], clickhouse: client,
    statePath: join(dir, "state.json"), rateBytesPerSec: 0,
    zstd: {
      fingerprint: async path => { calls.reads++; return compressedHash(path); },
      spawn: path => { calls.spawns++; return spawnZstd(path); },
    },
  };
  return { physical, logical, rows, tokens, calls, opts, checkpoint: () => loadState(opts.statePath).files[logical] };
}

test.each([
  ["partial JSON", Buffer.concat([meta, Buffer.from('{"tail":')]), meta.length],
  ["valid JSON without LF", Buffer.concat([meta, Buffer.from('{"tail":"שלום"}')]), meta.length],
  ["no complete line", Buffer.from('{"tail":"שלום"}'), 0],
] as const)("compressed completion retains %s", async (name, bytes, offset) => {
  const f = fixture(bytes);
  const decoded = await inspectZstd(f.physical, 0);
  expect(decoded.size).toBe(bytes.length);
  expect(decoded.digest).toBe(digest(bytes));
  expect(bytes.lastIndexOf(10) + 1).toBe(offset);
  const first = await shipOnce(f.opts), checkpoint = f.checkpoint();
  expect(first.bytes).toBe(offset); expect(first.lines).toBe(offset ? 1 : 0);
  expect(checkpoint.offset).toBe(offset);
  expect(checkpoint.fingerprint).toBe(offset ? digest(meta) : "");
  if (offset) {
    expect(f.rows[0]).toMatchObject({ path: f.logical, byte_offset: 0,
      line_bytes: meta.length, content_hash: digest(meta), session_id: "owned-session", harness: "t3" });
    expect(f.rows[0][RAW_BYTES]).toEqual(meta);
  }
  expect(checkpoint.compressed?.complete).toBe(false);
  const calls = { ...f.calls };
  expect((await shipOnce(f.opts)).lines).toBe(0);
  expect(f.calls).toEqual({ reads: calls.reads + 1, spawns: calls.spawns + 2 });
  expect(f.checkpoint()).toEqual(checkpoint);
  expect(f.rows).toHaveLength(offset ? 1 : 0);
  if (offset) {
    const row = f.rows[0], token = f.tokens[0];
    unlinkSync(f.opts.statePath);
    expect((await shipOnce(f.opts)).lines).toBe(1);
    expect(f.rows[1]).toEqual(row); expect(f.tokens[1]).toBe(token);
    expect(f.checkpoint()).toEqual(checkpoint);
  }
  console.info(JSON.stringify({ case: name, decodedBytes: decoded.size, completeLineBytes: offset, complete: false }));
});

test.each([meta, Buffer.alloc(0)])("full decoded input with no tail completes and skips unchanged bytes", async bytes => {
  const f = fixture(bytes), decoded = await inspectZstd(f.physical, 0);
  expect(decoded.size).toBe(bytes.length);
  expect((await shipOnce(f.opts)).bytes).toBe(decoded.size);
  expect(f.checkpoint().offset).toBe(decoded.size);
  expect(f.checkpoint().compressed?.complete).toBe(true);
  const calls = { ...f.calls }, checkpoint = f.checkpoint();
  expect((await shipOnce(f.opts)).lines).toBe(0);
  expect(f.calls).toEqual(calls); expect(f.checkpoint()).toEqual(checkpoint);
});

test("line-capped compressed prefix stays incomplete until the final LF is acknowledged", async () => {
  const bytes = Buffer.concat([meta, Buffer.from("{}\n")]), f = fixture(bytes);
  expect((await shipOnce({ ...f.opts, maxLines: 1 })).bytes).toBe(meta.length);
  expect(f.checkpoint().compressed?.complete).toBe(false);
  expect((await shipOnce({ ...f.opts, maxLines: 1 })).bytes).toBe(3);
  expect(f.checkpoint().offset).toBe(bytes.length);
  expect(f.checkpoint().compressed?.complete).toBe(true);
});
