import { expect, test } from "bun:test";
import { runLoop } from "../../src/steer/loop";
import { HubClient } from "../../src/steer/client";
import { tick } from "../../src/steer/steer";

for (const method of ["GET", "PATCH"]) test(`backs off repeated ${method} 503s, honours Retry-After and recovers`, async () => {
  let count = 0;
  const server = Bun.serve({ port: 0, fetch(req) {
    if (req.method === method && count++ < 3) return new Response("busy", { status: 503, headers: { "Retry-After": "10" } });
    return Response.json({ files: method === "PATCH" ? [{ id: "a", provider: "claude", account_type: "oauth", priority: 0 }] : [] });
  } });
  let now = 0;
  const starts: number[] = [];
  const waits: number[] = [];
  const client = new HubClient(server.url.toString(), "synthetic-key");
  try {
    await runLoop({
      intervalMs: 1000, now: () => now, random: () => 0,
      stopping: () => starts.length >= 5, sleep: async ms => { waits.push(ms); now += ms; },
      execute: async () => { starts.push(now); return tick(client, { log: () => {} }); },
      log: () => {},
    });
    expect(starts.slice(0, 4)).toEqual([0, 10000, 20000, 30000]);
    expect(waits.at(-1)).toBe(1000);
  } finally { server.stop(true); }
});

test("slow failed ticks retain a full delay and exponential growth is capped", async () => {
  let now = 0;
  const waits: number[] = [];
  await runLoop({
    intervalMs: 1000, now: () => now, random: () => 0,
    stopping: () => waits.length === 12,
    sleep: async ms => { waits.push(ms); now += ms; },
    execute: async () => { now += 1300; throw new Error("503"); }, log: () => {},
  });
  expect(waits.slice(0, 3)).toEqual([2000, 4000, 8000]);
  expect(waits.at(-1)).toBe(300000);
});

for (const method of ["GET", "PATCH"]) test(`${method} errors redact echoed credentials before truncation`, async () => {
  const key = "synthetic!management$key";
  const server = Bun.serve({ port: 0, fetch() {
    return Response.json({ error: `${"x".repeat(10)} ${key} Authorization: Basic abcdef Bearer opaque-secret` }, { status: 503 });
  } });
  try {
    const client = new HubClient(server.url.toString(), key);
    const error = await (method === "GET" ? client.list() : client.setPriority("a", 50)).catch(e => String(e));
    expect(error).not.toContain(key);
    expect(error).not.toContain("synthetic!");
    expect(error).not.toContain("abcdef");
    expect(error).not.toContain("opaque-secret");
    expect(error).toContain("503");
  } finally { server.stop(true); }
});

test("jitter is applied, recovery resets growth, and Retry-After is capped", async () => {
  const { HubError } = await import("../../src/steer/client");
  const waits: number[] = [];
  let calls = 0;
  await runLoop({
    intervalMs: 1000, random: () => 0.5, now: () => 0,
    stopping: () => waits.length === 5,
    sleep: async ms => { waits.push(ms); },
    execute: async () => {
      calls++;
      if (calls === 3) return { credentials: 0, changes: 0, errors: 0 };
      if (calls === 5) throw new HubError("503", 999999999);
      throw new Error("503");
    }, log: () => {},
  });
  expect(waits).toEqual([2250, 4500, 1000, 2250, 300000]);
});

test("Retry-After accepts HTTP dates, clamps seconds, and ignores garbage", async () => {
  const { HubError } = await import("../../src/steer/client");
  let header = new Date(Date.now() + 60000).toUTCString();
  const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 503, headers: { "Retry-After": header } }) });
  try {
    for (const value of [header, "999999999", "garbage"]) {
      header = value;
      const error = await new HubClient(server.url.toString(), "synthetic-key").list().catch(e => e);
      expect(error).toBeInstanceOf(HubError);
      if (value === "999999999") expect(error.retryAfterMs).toBe(300000);
      else if (value === "garbage") expect(error.retryAfterMs).toBe(0);
      else { expect(error.retryAfterMs).toBeGreaterThan(58000); expect(error.retryAfterMs).toBeLessThanOrEqual(60000); }
    }
  } finally { server.stop(true); }
});
