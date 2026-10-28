import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "../../src/steer/client";
import { loadEnv } from "../../src/steer/env";

const KEY = "test-mgmt-key";
const seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "PATCH" ? await req.json() : null;
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ error: "invalid management key" }, { status: 401 });
      if (req.method === "GET" && url.pathname === "/v8/management/credentials") {
        return Response.json({ files: [{ id: "claude-a.json", provider: "claude", priority: 50 }], observed_at: "2026-10-28T08:00:00Z" });
      }
      if (req.method === "PATCH" && url.pathname === "/v8/management/credentials/fields") {
        return (body as { name?: string }).name === "missing" ? Response.json({ error: "auth file not found" }, { status: 404 }) : Response.json({ status: "ok" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}`;

test("lists credentials with the bearer management key", async () => {
  const files = await new HubClient(base(), KEY).list();
  expect(files).toEqual([{ id: "claude-a.json", provider: "claude", priority: 50 }]);
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v8/management/credentials", auth: `Bearer ${KEY}` });
});

test("sets priority through PATCH /credentials/fields keyed by credential id", async () => {
  await new HubClient(`${base()}/`, KEY).setPriority("claude-a.json", 100);
  expect(seen.at(-1)).toMatchObject({ method: "PATCH", path: "/v8/management/credentials/fields", body: { name: "claude-a.json", priority: 100 } });
});

test("HTTP errors surface the status and the hub's error text, never the key", async () => {
  const err = await new HubClient(base(), KEY).setPriority("missing", 50).catch((e: Error) => e);
  expect(String(err)).toContain("404");
  expect(String(err)).toContain("auth file not found");
  const denied = await new HubClient(base(), "wrong-key").list().catch((e: Error) => e);
  expect(String(denied)).toContain("401");
  expect(String(denied)).not.toContain("wrong-key");
});

test("env file values load under the process env, which wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenlayer-steer-env-"));
  try {
    const file = join(dir, "hub.env");
    writeFileSync(file, `# hub\nexport CLIPROXY_MGMT_KEY="from-file"\nTOKENLAYER_HUB_URL=http://hub:8317\n`);
    const env = loadEnv(file, { TOKENLAYER_HUB_URL: "http://override:1" });
    expect(env.CLIPROXY_MGMT_KEY).toBe("from-file");
    expect(env.TOKENLAYER_HUB_URL).toBe("http://override:1");
    expect(loadEnv(join(dir, "missing.env"), {})).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
