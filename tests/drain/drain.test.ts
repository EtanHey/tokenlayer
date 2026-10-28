import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/usage-queue.json";
import { drainOnce } from "../../src/drain/drain";
import { Spool } from "../../src/drain/spool";
import { ClickHouse } from "../../src/lib/clickhouse";

type Insert = { query: string; token: string | null; rows: unknown[]; user: string | null };

function fakeClickHouse(failFirst: number) {
  const inserts: Insert[] = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      const url = new URL(req.url);
      const body = await req.text();
      if (calls <= failFirst) return new Response("Code: 210. Connection refused", { status: 503 });
      inserts.push({
        query: url.searchParams.get("query") ?? "",
        token: url.searchParams.get("insert_deduplication_token"),
        rows: body.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
        user: req.headers.get("x-clickhouse-user"),
      });
      return new Response("");
    },
  });
  return { server, inserts, calls: () => calls };
}

function fakeHub(pages: unknown[][]) {
  const seen: { count: string | null; auth: string | null; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ count: url.searchParams.get("count"), auth: req.headers.get("authorization"), path: url.pathname });
      return Response.json(pages.shift() ?? []);
    },
  });
  return { server, seen };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenlayer-drain-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ch = (port: number | undefined) =>
  new ClickHouse({ url: `http://127.0.0.1:${port}`, user: "tl", password: "pw", database: "tokenlayer" });

describe("drainOnce", () => {
  test("pops the queue with a bearer key and inserts mapped rows", async () => {
    const hub = fakeHub([fixture]);
    const db = fakeClickHouse(0);
    const result = await drainOnce({
      hubUrl: `http://127.0.0.1:${hub.server.port}`,
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch(db.server.port),
      spool: new Spool(dir),
      pageSize: 500,
    });
    hub.server.stop(true);
    db.server.stop(true);

    expect(result).toEqual({ drained: 2, inserted: 2, spooled: 0, rejected: 0 });
    expect(hub.seen[0]).toEqual({ count: "500", auth: "Bearer k", path: "/v8/management/observability/usage/queue" });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].query).toBe("INSERT INTO tokenlayer.proxy_usage FORMAT JSONEachRow");
    expect(db.inserts[0].token).toMatch(/^[0-9a-f]{64}$/);
    expect(db.inserts[0].user).toBe("tl");
    expect(db.inserts[0].rows).toHaveLength(2);
    expect(new Spool(dir).pending()).toBe(0);
  });

  test("keeps paging while a page comes back full", async () => {
    const hub = fakeHub([[fixture[0], fixture[1]], [fixture[0]]]);
    const db = fakeClickHouse(0);
    const result = await drainOnce({
      hubUrl: `http://127.0.0.1:${hub.server.port}`,
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch(db.server.port),
      spool: new Spool(dir),
      pageSize: 2,
    });
    hub.server.stop(true);
    db.server.stop(true);
    expect(hub.seen).toHaveLength(2);
    expect(result.drained).toBe(3);
  });

  test("spools drained records when ClickHouse is down, then retries with the same token", async () => {
    const db = fakeClickHouse(1);
    const hub1 = fakeHub([fixture]);
    const first = await drainOnce({
      hubUrl: `http://127.0.0.1:${hub1.server.port}`,
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch(db.server.port),
      spool: new Spool(dir),
      pageSize: 500,
    });
    hub1.server.stop(true);
    expect(first).toEqual({ drained: 2, inserted: 0, spooled: 2, rejected: 0 });
    expect(new Spool(dir).pending()).toBe(1);

    // A fresh process (new Spool instance) finds the batch on disk and flushes it.
    const hub2 = fakeHub([]);
    const second = await drainOnce({
      hubUrl: `http://127.0.0.1:${hub2.server.port}`,
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch(db.server.port),
      spool: new Spool(dir),
      pageSize: 500,
    });
    hub2.server.stop(true);
    db.server.stop(true);
    expect(second).toEqual({ drained: 0, inserted: 2, spooled: 0, rejected: 0 });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].rows).toHaveLength(2);
    expect(new Spool(dir).pending()).toBe(0);
  });

  test("records the drain even if the hub is unreachable after the spool flush", async () => {
    const db = fakeClickHouse(0);
    const result = await drainOnce({
      hubUrl: "http://127.0.0.1:1",
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch(db.server.port),
      spool: new Spool(dir),
      pageSize: 500,
    }).catch((e: Error) => e);
    db.server.stop(true);
    expect(result).toBeInstanceOf(Error);
  });

  test("never drops unmappable records: they go to the rejects file", async () => {
    const hub = fakeHub([["not-an-object", fixture[0]]]);
    const db = fakeClickHouse(0);
    const result = await drainOnce({
      hubUrl: `http://127.0.0.1:${hub.server.port}`,
      mgmtKey: "k",
      hub: "m1",
      clickhouse: ch(db.server.port),
      spool: new Spool(dir),
      pageSize: 500,
    });
    hub.server.stop(true);
    db.server.stop(true);
    expect(result).toEqual({ drained: 2, inserted: 1, spooled: 0, rejected: 1 });
    const rejects = join(dir, "rejects.ndjson");
    expect(existsSync(rejects)).toBe(true);
    expect(readFileSync(rejects, "utf8")).toContain("not-an-object");
  });
});

describe("Spool", () => {
  test("flush stops at the first failing batch and keeps it and everything after", async () => {
    const spool = new Spool(dir);
    spool.append([{ a: 1 }]);
    spool.append([{ a: 2 }]);
    spool.append([{ a: 3 }]);
    const sent: number[] = [];
    let n = 0;
    const flush = spool.flush(async (rows) => {
      n++;
      if (n === 2) throw new Error("boom");
      sent.push((rows[0] as { a: number }).a);
    });
    await expect(flush).rejects.toThrow("boom");
    expect(sent).toEqual([1]);
    const again = new Spool(dir);
    expect(again.pending()).toBe(2);
    const tokens = again.batches().map((b) => b.token);
    expect(new Set(tokens).size).toBe(2);
  });

  test("a batch keeps its dedup token across processes", () => {
    const spool = new Spool(dir);
    const token = spool.append([{ a: 1 }]);
    expect(new Spool(dir).batches()[0].token).toBe(token);
  });

  test("survives a torn last line from a crash mid-append", async () => {
    const spool = new Spool(dir);
    spool.append([{ a: 1 }]);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "spool.ndjson"), '{"token":"abc","rows":[{"a"');
    expect(new Spool(dir).pending()).toBe(1);
  });
});
