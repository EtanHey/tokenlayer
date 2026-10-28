import { describe, expect, test } from "bun:test";
import { ClickHouse } from "../../src/lib/clickhouse";

function server(respond: (req: Request) => Response) {
  const seen: URL[] = [];
  const s = Bun.serve({
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
