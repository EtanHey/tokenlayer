import { describe, expect, spyOn, test } from "bun:test";
import { ClickHouse, RAW_BYTES } from "../../src/lib/clickhouse";
import { DEFAULT_UNSENT_RETRY_MS, RetryingClickHouse, StoreUnreachableError } from "../../src/lib/clickhouse-retry";
import { verifySessionSchema, migrateSessionSchema } from "../../src/lib/session-schema";
import { applySchema } from "../../src/lib/schema";
import { StreamingHistoryClient } from "../../scripts/history/stream";
import { checkSpace } from "../../scripts/deploy/backfill";
import { validateSample } from "../../src/archaeology/validation";
import { cloneRawClient } from "../../src/raw-document/client";
import { drainOnce } from "../../src/drain/drain";

function server(respond: (req: Request) => Response) {
  const seen: URL[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen.push(new URL(req.url));
      await req.text();
      return respond(req);
    },
  });
  const client = new ClickHouse({ url: `http://127.0.0.1:${s.port}`, user: "u", password: "p", database: "tokenlayer" });
  return { s, seen, client };
}

describe("ClickHouse.insert", () => {
  test("asks the server to buffer the response so errors get a real status code", async () => {
    const { s, seen, client } = server(() => new Response(""));
    await client.insert("t", [{ a: 1 }]);
    s.stop(true);
    expect(seen[0].searchParams.get("wait_end_of_query")).toBe("1");
    expect(seen[0].searchParams.get("async_insert")).toBe("0");
  });

  test("an HTTP 200 carrying X-ClickHouse-Exception-Code is a failure", async () => {
    const { s, client } = server(
      () =>
        new Response("Code: 209. DB::Exception: Timeout exceeded while writing to socket. (SOCKET_TIMEOUT)", {
          status: 200,
          headers: { "X-ClickHouse-Exception-Code": "209" },
        }),
    );
    await expect(client.insert("t", [{ a: 1 }])).rejects.toThrow("209");
    s.stop(true);
  });

  test("an HTTP 200 whose body ends in an exception (no header) is a failure", async () => {
    const { s, client } = server(() => new Response("Code: 27. DB::Exception: Cannot parse input. (CANNOT_PARSE_INPUT_ASSERTION_FAILED)"));
    await expect(client.insert("t", [{ a: 1 }])).rejects.toThrow("CANNOT_PARSE");
    s.stop(true);
  });

  test("error text is redacted before it can reach a log", async () => {
    const leaked = "Code: 27. DB::Exception: Cannot parse input: row {\"fail_body\":\"key sk-ant-api03-FAKEfakeFAKEfake0123 bob@example.invalid\"}";
    const { s, client } = server(() => new Response(leaked, { status: 500 }));
    const err = (await client.insert("t", [{ a: 1 }]).catch((e: Error) => e)) as Error;
    s.stop(true);
    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain("sk-ant-api03-FAKEfakeFAKEfake0123");
    expect(err.message).not.toContain("bob@example.invalid");
  });
});

const refused = /^CLICKHOUSE_DATABASE_UNSUPPORTED$/;
describe("fixed-schema database admission", () => {
  for (const database of ["other", "", "private-target\nuser:password"]) {
    test(`env target refuses before session schema queries (${database.length} chars)`, async () => {
      const { s, seen, client } = server(() => new Response(""));
      try {
        const ch = ClickHouse.fromEnv({ CLICKHOUSE_URL: client.config.url, CLICKHOUSE_DB: database });
        await expect(verifySessionSchema(ch)).rejects.toThrow(refused);
        expect(seen).toHaveLength(0);
      } finally { console.log(`DATABASE_ADMISSION env requests=${seen.length}`); s.stop(true); }
    });
  }
  const admissions = { verifySessionSchema, migrateSessionSchema, applySchema,
    drainOnce: (ch: ClickHouse) => drainOnce({ clickhouse: ch, hubUrl: ch.config.url, mgmtKey: "fixture", hub: "fixture",
      get spool(): never { throw Error("SPOOL_ACCESSED_BEFORE_REFUSAL"); } }),
    checkSpace: (ch: ClickHouse) => checkSpace(ch, 0),
    validateSample: (ch: ClickHouse) => validateSample(ch, []) };
  for (const [name, admit] of Object.entries(admissions)) {
    test(`direct client refuses before ${name} effects`, async () => {
      const { s, seen, client } = server(() => new Response(""));
      try {
        const ch = new ClickHouse({ ...client.config, database: "other" });
        await expect(admit(ch)).rejects.toThrow(refused);
        expect(seen).toHaveLength(0);
      } finally { console.log(`DATABASE_ADMISSION ${name} requests=${seen.length}`); s.stop(true); }
    });
  }
  for (const table of ["session_events", "proxy_usage", "archaeology_sample"]) {
    test(`direct ${table} insert refuses before encoding or HTTP`, async () => {
      const { s, seen, client } = server(() => new Response(""));
      try {
        const ch = new ClickHouse({ ...client.config, database: "other" });
        await expect(ch.insert(table, [])).rejects.toThrow(refused);
        await expect(ch.insert(table, { get length(): never { throw Error("ROWS_ACCESSED_BEFORE_REFUSAL"); } } as unknown as readonly unknown[])).rejects.toThrow(refused);
        await expect(ch.insert(table, [{ a: 1 }])).rejects.toThrow(refused);
        // A throwing serializer proves refusal precedes row encoding as well as HTTP.
        await expect(ch.insert(table, [{ toJSON() { throw Error("ENCODED_BEFORE_REFUSAL"); } }])).rejects.toThrow(refused);
        expect(seen).toHaveLength(0);
      } finally { console.log(`DATABASE_ADMISSION ${table} requests=${seen.length}`); s.stop(true); }
    });
  }
  test("direct streaming client refuses before opening a ledger", () => {
    expect(() => new StreamingHistoryClient({ url: "unused", user: "", password: "", database: "other" }, {
      get ledger(): string { throw Error("LEDGER_ACCESSED_BEFORE_REFUSAL"); },
      manifest: "fixture", run: "fixture", sessionId: "fixture",
    })).toThrow(refused);
  });
  for (const database of [undefined, "tokenlayer"]) {
    test(`default/explicit tokenlayer retains insert and query framing (${database ?? "default"})`, async () => {
      const { s, seen, client } = server(() => new Response(""));
      try {
        const ch = ClickHouse.fromEnv({ CLICKHOUSE_URL: client.config.url, CLICKHOUSE_DB: database });
        await ch.insert("session_events", [{ a: 1 }], "fixture-token");
        await ch.exec("SELECT 1");
        expect(seen).toHaveLength(2);
        expect(seen[0].searchParams.get("query")).toBe("INSERT INTO tokenlayer.session_events FORMAT JSONEachRow");
        expect(seen[0].searchParams.get("insert_deduplication_token")).toBe("fixture-token");
        expect(seen[1].searchParams.get("query")).toBeNull();
      } finally { s.stop(true); }
    });
  }
  test("generic env, direct construction and raw-client cloning retain arbitrary database and raw bytes", async () => {
    const bodies: Buffer[] = [];
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      bodies.push(Buffer.from(await req.arrayBuffer())); return new Response("");
    } });
    try {
      const ch = ClickHouse.fromEnv({ CLICKHOUSE_URL: s.url.origin, CLICKHOUSE_DB: "synthetic" });
      const clone = cloneRawClient(ch); ch.config.database = "changed";
      await clone.insert("raw_documents", [{ raw: "", [RAW_BYTES]: Buffer.from([0x80, 0xff]) }]);
      expect(clone.config.database).toBe("synthetic");
      expect(bodies).toEqual([Buffer.from([123, 34, 114, 97, 119, 34, 58, 34, 128, 255, 34, 125, 10])]);
    } finally { s.stop(true); }
  });
  test("generic direct inserts retain exact table selection and arbitrary database", async () => {
    const { s, seen, client } = server(() => new Response(""));
    try {
      const ch = new ClickHouse({ ...client.config, database: "synthetic" });
      for (const table of ["", "Session_events", "session_events_extra", "tokenlayer.session_events", "raw_documents"]) {
        await ch.insert(table, []);
        expect(seen).toHaveLength(0);
      }
      await ch.insert("raw_documents", [{ a: 1 }], "fixture-token");
      expect(seen).toHaveLength(1);
      expect(seen[0].searchParams.get("query")).toBe("INSERT INTO synthetic.raw_documents FORMAT JSONEachRow");
      expect(seen[0].searchParams.get("insert_deduplication_token")).toBe("fixture-token");
    } finally { s.stop(true); }
  });
  test("direct admissions recheck a client's current database", async () => {
    const { s, seen, client } = server(() => new Response(""));
    try {
      for (const table of ["session_events", "proxy_usage", "archaeology_sample"]) {
        client.config.database = "tokenlayer";
        await client.insert(table, []);
        client.config.database = "other";
        await expect(client.insert(table, [])).rejects.toThrow(refused);
      }
      await expect(verifySessionSchema(client)).rejects.toThrow(refused);
      expect(seen).toHaveLength(0);
    } finally { s.stop(true); }
  });
});

describe("ClickHouse.exec", () => {
  test("an HTTP 200 carrying X-ClickHouse-Exception-Code is a failure", async () => {
    const { s, seen, client } = server(
      () => new Response("partial\nCode: 241. DB::Exception: Memory limit", { headers: { "X-ClickHouse-Exception-Code": "241" } }),
    );
    await expect(client.exec("SELECT 1")).rejects.toThrow("241");
    s.stop(true);
    expect(seen[0].searchParams.get("wait_end_of_query")).toBe("1");
  });
});

// R9: the M4 lost DNS for the hub's tailnet name in bursts (11-18 09:18-09:47Z, 11-19 06:10-12:41Z). Every
// failed insert left the ship's journal ahead of its checkpoint, which became a re-send.
describe("RetryingClickHouse unsent-request retry", () => {
  const rejectWith = (message: string, code: string) =>
    (() => Promise.reject(Object.assign(new Error(message), { code }))) as unknown as typeof fetch;
  const dnsFailure = rejectWith("getaddrinfo ENOTFOUND hub.example", "ENOTFOUND");

  test("a DNS failure is retried with backoff and the insert lands exactly once", async () => {
    const { s, seen, client } = server(() => new Response(""));
    const quick = new RetryingClickHouse(client.config, [1, 1, 1]);
    const spy = spyOn(globalThis, "fetch");
    spy.mockImplementationOnce(dnsFailure).mockImplementationOnce(dnsFailure);
    try {
      await quick.insert("session_events", [{ a: 1 }], "token-1");
      expect(spy).toHaveBeenCalledTimes(3);
      expect(seen).toHaveLength(1);
      expect(seen[0].searchParams.get("insert_deduplication_token")).toBe("token-1");
    } finally { spy.mockRestore(); s.stop(true); }
  });

  test("a refused connection that never recovers fails as StoreUnreachableError after every retry", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const spy = spyOn(globalThis, "fetch");
    try {
      const err = await new RetryingClickHouse({ url, user: "u", password: "p", database: "tokenlayer" }, [1, 1])
        .insert("session_events", [{ a: 1 }]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreUnreachableError);
      expect(err).toMatchObject({ code: "ECONNREFUSED", attempts: 3 });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally { spy.mockRestore(); }
  });

  test("an answer from the server is never retried, even an error", async () => {
    const { s, seen, client } = server(() => new Response("down", { status: 503 }));
    try {
      await expect(new RetryingClickHouse(client.config, [1, 1]).exec("SELECT 1")).rejects.toThrow("HTTP 503");
      expect(seen).toHaveLength(1);
    } finally { s.stop(true); }
  });

  test("a reset after the request may have been read is not retried", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(rejectWith("The socket connection was closed unexpectedly.", "ECONNRESET"));
    try {
      const err = await new RetryingClickHouse({ url: "http://hub.example", user: "u", password: "p", database: "tokenlayer" }, [1, 1])
        .exec("SELECT 1").catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(StoreUnreachableError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  test("the default backoff rides out about 14 s of DNS loss", () => {
    expect(DEFAULT_UNSENT_RETRY_MS.reduce((a, b) => a + b, 0)).toBe(14_000);
    expect(RetryingClickHouse.fromEnv({}).unsentRetryMs).toBe(DEFAULT_UNSENT_RETRY_MS);
  });

  // The retry lives in a ship-only subclass so the drain bundle (hub-local, ratchet row bundle-drain-bytes)
  // does not carry it. The plain client therefore fails fast, and the ship must build the retrying one.
  test("only the ship's client retries; the plain client fails on the first unsent request", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(dnsFailure);
    try {
      const err = await new ClickHouse({ url: "http://hub.example", user: "u", password: "p", database: "tokenlayer" })
        .exec("SELECT 1").catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(StoreUnreachableError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
    const shipMain = await Bun.file(new URL("../../src/ship/main.ts", import.meta.url)).text();
    expect(shipMain).toContain("RetryingClickHouse.fromEnv(env)");
    expect(RetryingClickHouse.fromEnv({ CLICKHOUSE_URL: "http://hub.example" }).config.url).toBe("http://hub.example");
  });
});
