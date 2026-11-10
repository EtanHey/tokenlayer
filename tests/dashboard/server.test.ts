import { test, expect } from "bun:test";
import { createHandler } from "../../src/dashboard/server";
test("identity, CSRF and safe failures", async () => {
  const handler = createHandler({
    logins: ["owner"],
    origin: "https://dash.test",
    secret: "canary-secret",
    hub: {
      observations: async () => {
        throw Error("canary-secret");
      },
    } as any,
    ch: {} as any,
  });
  expect((await handler(new Request("https://dash.test/api/state"))).status).toBe(403);
  const r = await handler(
    new Request("https://dash.test/api/accounts", { headers: { "Tailscale-User-Login": "owner" } }),
  );
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("canary-secret");
  expect(
    (
      await handler(
        new Request("https://dash.test/api/resets", {
          method: "POST",
          headers: { "Tailscale-User-Login": "owner" },
        }),
      )
    ).status,
  ).toBe(403);
});
test("GET contracts with fake hub and ClickHouse; invalid writes cannot mutate", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/dashboard-");
  const handler = createHandler({
    logins: ["owner"],
    origin: "https://dash.test",
    secret: "secret",
    path: dir + "/state",
    events: dir + "/events",
    hub: {
      observations: async () => [{ id: "claude-test.json", email: "test", status: "active", cooldowns: [] }],
      catalog: async () => ["claude-fable-5-2"],
    } as any,
    ch: { queryJSON: async () => [] },
  });
  const headers = { "Tailscale-User-Login": "owner" };
  for (const path of [
    "state",
    "accounts",
    "metrics?window=48h",
    "metrics?window=7d",
    "burn",
    "recommendation",
  ])
    expect((await handler(new Request("https://dash.test/api/" + path, { headers }))).status).toBe(200);
  const page = await (await handler(new Request("https://dash.test/", { headers }))).text();
  const token = page.match(/content="([a-f0-9]+)"/)![1];
  const post = (origin: string, body: unknown) =>
    handler(
      new Request("https://dash.test/api/switch", {
        method: "POST",
        headers: { ...headers, Origin: origin, "X-CSRF-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  expect((await post("https://evil.test", {})).status).toBe(403);
  expect((await post("https://dash.test", { mode: "auto", strict: true, spillover: false })).status).toBe(
    400,
  );
});

test("unsupported methods advertise allowed methods", async () => {
  const handle = createHandler({ logins: ["owner"], origin: "https://dash.test",
    secret: "fixture", hub: {} as any, ch: {} as any });
  const response = await handle(new Request("https://dash.test/api/state", {
    method: "DELETE", headers: { "Tailscale-User-Login": "owner" },
  }));
  expect(response.status).toBe(405);
  expect(response.headers.get("Allow")).toBe("GET, POST");
});
