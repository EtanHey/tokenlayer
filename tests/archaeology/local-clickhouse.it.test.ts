import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { clickhouseBinary, startLocalClickHouse } from "../../src/lib/local-clickhouse";

test.skipIf(!clickhouseBinary())("S-7 production local ClickHouse helper serves a real isolated request", async () => {
  const local=await startLocalClickHouse();
  try {expect(await local.client.exec("SELECT 1")).toBe("1\n");}
  finally {await local.stop();}
}, 40_000);

function socket() {
  return Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nOk.");
  } } });
}

test.skipIf(!clickhouseBinary())("local ClickHouse starts concurrent servers on distinct ports", async () => {
  const results = await Promise.allSettled([false, true, false].map(queryLog => startLocalClickHouse({ queryLog })));
  const servers = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  try {
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(new Set(servers.map(ch => ch.client.config.url)).size).toBe(3);
    expect(await Promise.all(servers.map(ch => ch.client.queryJSON("SELECT 1 AS ok"))))
      .toEqual([[{ ok: 1 }], [{ ok: 1 }], [{ ok: 1 }]]);
  } finally { await Promise.all(servers.map(ch => ch.stop())); }
}, 40_000);

for (const queryLog of [false, true]) for (const listener of ["http", "tcp"]) test.skipIf(!clickhouseBinary())(`local ClickHouse retries an occupied ${listener} port (queryLog=${queryLog})`, async () => {
  const busy = socket();
  let attempts = 0;
  try {
    const ch = await startLocalClickHouse({ queryLog }, () => {
      const http = socket();
      const tcp = socket();
      try {
        attempts++;
        return {
          http: attempts === 1 && listener === "http" ? busy.port : http.port,
          tcp: attempts === 1 && listener === "tcp" ? busy.port : tcp.port,
        };
      } finally { http.stop(true); tcp.stop(true); }
    });
    try {
      expect(attempts).toBe(2);
      expect(await ch.client.queryJSON("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
    } finally { await ch.stop(); }
  } finally { busy.stop(true); }
}, 30_000);

test.skipIf(!clickhouseBinary())("local ClickHouse stops after three exits and includes the final error log tail", async () => {
  const busy = socket();
  let attempts = 0;
  try {
    const error: unknown = await startLocalClickHouse({}, () => {
      const http = socket();
      http.stop(true);
      attempts++;
      return { http: http.port, tcp: busy.port };
    }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected startup failure");
    expect(attempts).toBe(3);
    const dir = error.message.match(/logs in ([^)]+)\)/)?.[1];
    expect(dir).toBeDefined();
    const tail = readFileSync(`${dir}/server.err.log`, "utf8").trimEnd().split("\n").slice(-20).join("\n");
    expect(tail).not.toBe("");
    expect(error.message).toContain(tail);
    expect(error.message).toContain("Address already in use");
  } finally { busy.stop(true); }
}, 30_000);
