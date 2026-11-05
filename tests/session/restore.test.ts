import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";
import { applySchema } from "../../src/lib/schema";
import { shipOnce } from "../../src/ship/ship";

const root = join(import.meta.dir, "../..");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
describe.skipIf(!clickhouseBinary())("session restore → real ClickHouse and CLI", () => {
  let ch: LocalClickHouse, dir: string, source: string, bytes: Buffer;
  const receiptFrom = (stdout: string) => JSON.parse(readFileSync(join(dirname(/^file=(.+)$/m.exec(stdout)![1]), "receipt.json"), "utf8"));
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn([join(root, "bin/tokenlayer"), "session", "restore", ...args], {
      cwd: root, env: { PATH: process.env.PATH, TOKENLAYER_ENV_FILES: "/dev/null", CLICKHOUSE_URL: ch.client.config.url },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  beforeAll(async () => {
    ch = await startLocalClickHouse();
    await applySchema(ch.client);
    dir = mkdtempSync(join(tmpdir(), "tokenlayer-restore-"));
    source = join(dir, "source.jsonl");
    bytes = Buffer.concat([
      Buffer.from('{"type":"queue-operation"}\n'),
      Buffer.from(' { "type":"session_meta", "timestamp":"2026-09-30T23:59:59Z", "payload":{"id":"native-id", "session_id":"alias-id"} }\r\n'),
      Buffer.from('{"type":"turn_context","timestamp":"2026-10-01T00:00:01Z","payload":{"model":"שלום"}}\n'),
      Buffer.from([0xff, 0xfe, 0, 34, 92, 10]),
    ]);
    writeFileSync(source, bytes);
    const opts = { machine: "m1", roots: [{ kind: "codex" as const, dir }], statePath: join(dir, "checkpoint"), clickhouse: ch.client, rateBytesPerSec: 0 };
    await shipOnce(opts);
    // Replay with different batches: duplicate physical rows must collapse across partitions.
    rmSync(opts.statePath);
    await shipOnce({ ...opts, batchBytes: 1 });
  }, 40_000);
  afterAll(async () => { await ch?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("reconstructs original bytes, including rows without ids, via native id or alias", async () => {
    for (const id of ["native-id", "alias-id"]) {
      const result = await cli(id, "--to", join(dir, "out"));
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const receipt = receiptFrom(result.stdout);
      expect(readFileSync(receipt.file).equals(bytes)).toBe(true);
      expect(receipt).toMatchObject({ bytes: bytes.length, rows: 4, sha256: hash(bytes), scope: "archived-contiguous-prefix", sourceComplete: "unknown" });
      expect(statSync(receipt.file).mode & 0o777).toBe(0o600);
      expect(statSync(receipt.directory).mode & 0o777).toBe(0o700);
    }
  });

  test("rejects cross-Mac/path/generation ambiguity; selectors isolate one identity", async () => {
    const [row] = await ch.client.queryJSON<Record<string, unknown>>("SELECT * EXCEPT ingested_at FROM tokenlayer.session_events FINAL WHERE session_id='native-id'");
    for (const change of [{ machine: "m4" }, { path: "/other/source.jsonl" }, { generation: "another-generation" }]) {
      await ch.client.insert("session_events", [{ ...row, ...change }]);
    }
    expect((await cli("native-id", "--to", join(dir, "ambiguous"))).code).toBe(1);
    const result = await cli("native-id", "--machine", "m1", "--path", source, "--generation", String(row.generation), "--to", join(dir, "selected"));
    expect(result.code).toBe(0);
    expect(readFileSync(receiptFrom(result.stdout).file).equals(bytes)).toBe(true);
  });

  test("rejects corrupt, legacy, gapped, overlapping and conflicting archives before publishing", async () => {
    const raw = Buffer.from('{"type":"user"}\n');
    const base = { machine: "bad", path: "/bad.jsonl", generation: "g", byte_offset: 0, line_bytes: raw.length, raw: raw.toString(), content_hash: hash(raw), ts: "2026-10-28 00:00:00.000" };
    const variants = [
      [{ content_hash: "legacy:" + hash(raw) }], [{ line_bytes: raw.length + 1 }], [{ content_hash: "0".repeat(64) }],
      [{ byte_offset: 1 }], [{}, { byte_offset: raw.length + 1 }], [{}, { byte_offset: 1 }],
      [{}, { raw: "{}\n", line_bytes: 3, content_hash: hash(Buffer.from("{}\n")) }],
    ];
    for (let i = 0; i < variants.length; i++) {
      const id = `bad-${i}`, to = join(dir, id);
      await ch.client.insert("session_events", variants[i].map(v => ({ ...base, ...v, session_id: id, path: `/${id}.jsonl` })));
      const result = await cli(id, "--to", to);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(await Bun.file(join(to, "session.jsonl")).exists()).toBe(false);
      expect(readdirSync(dir).includes(id)).toBe(false);
      expect(result.stderr).toMatch(/archive (has a gap|lacks a source-byte hash|byte length or hash mismatch)/);
    }
  });

  test("source blank lines are rejected as gaps; an unshipped tail is never claimed complete", async () => {
    const gap = join(dir, "gap.jsonl"), tail = join(dir, "tail.jsonl");
    const line = (id: string) => `{"sessionId":"${id}"}\n`;
    writeFileSync(gap, line("gap") + "\n" + line("gap"));
    writeFileSync(tail, line("tail") + '{"partial":');
    await shipOnce({ machine: "edge", roots: [{ kind: "claude", dir }], statePath: join(dir, "edges-state"), clickhouse: ch.client, rateBytesPerSec: 0 });
    expect((await cli("gap", "--to", join(dir, "gap-out"))).code).toBe(1);
    const result = await cli("tail", "--to", join(dir, "tail-out"));
    expect(result.code).toBe(0);
    const receipt = receiptFrom(result.stdout);
    expect(readFileSync(receipt.file)).toEqual(Buffer.from(line("tail")));
    expect(receipt.sourceComplete).toBe("unknown");
  });

  test("missing sessions, SQL-shaped ids and invalid flags fail without creating output", async () => {
    for (const args of [["missing"], ["' OR 1=1 --"], ["native-id", "--typo"], ["native-id", "--to"]]) {
      const result = await cli(...args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  test("protects repo output, symlink aliases, and existing restores", async () => {
    const repo = join(dir, "output-repo");
    const { mkdirSync, symlinkSync } = await import("node:fs");
    mkdirSync(repo);
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    const run = (to: string) => cli("tail", "--to", to);
    const denied = await run(join(repo, "unignored"));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("gitignored");
    expect(readdirSync(repo)).toEqual([".git"]);
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    const first = await run(join(repo, "ignored"));
    expect(first.code).toBe(0);
    const receipt = receiptFrom(first.stdout);
    const second = await run(join(repo, "ignored"));
    expect(second.code).toBe(0);
    expect(receiptFrom(second.stdout).file).not.toBe(receipt.file);
    expect(hash(readFileSync(receipt.file))).toBe(receipt.sha256);
    const alias = join(dir, "repo-alias");
    symlinkSync(repo, alias);
    expect((await run(join(alias, "unignored"))).code).toBe(1);
    // A broken Git configuration must not be mistaken for a non-repo destination.
    const existing = readdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, ".git/config"), "[broken\n");
    const invalid = await run(join(repo, "ignored"));
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("cannot verify");
    expect(readdirSync(join(repo, "ignored"))).toEqual(existing);
  });

  test("does not echo payloads or server diagnostics on query failure", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("private-archive-payload", { status: 500 }) });
    try {
      const proc = Bun.spawn([process.execPath, "src/session/main.ts", "session", "restore", "x"], {
        cwd: root, env: { PATH: process.env.PATH, TOKENLAYER_ENV_FILES: "/dev/null", CLICKHOUSE_URL: server.url.href }, stdout: "pipe", stderr: "pipe",
      });
      expect(await proc.exited).toBe(1);
      expect(await new Response(proc.stdout).text()).toBe("");
      expect(await new Response(proc.stderr).text()).not.toContain("private-archive-payload");
    } finally { server.stop(true); }
  });
});
