import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { state, fakeHub } from "./fixtures";
import type { State, Fields } from "../../src/fable/core";

test("real CLI set/override/protect/off/adopt/status use API-only readbacks", async () => {
  const hub = fakeHub(),
    s = state(),
    dir = mkdtempSync(tmpdir() + "/fable-cli-");
  s.mode = "off";
  const path = dir + "/state";
  writeFileSync(path, JSON.stringify(s));
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(""); // Event shipping fixture.
      if (url.pathname.endsWith("/credentials/models"))
        return Response.json({
          models: (await hub.catalog(url.searchParams.get("name")!)).map(
            (id) => ({ id }),
          ),
        });
      if (req.method === "PATCH") {
        const body = (await req.json()) as Fields & { name: string };
        await hub.patch(body.name, body);
        return Response.json({ status: "ok" });
      }
      return Response.json({
        files: hub.obs.map((c) => ({
          ...c,
          provider: "claude",
          account_type: "oauth",
        })),
      });
    },
  });
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, "src/fable/main.ts", ...args], {
      env: {
        ...process.env,
        TOKENLAYER_ENV_FILES: "",
        TOKENLAYER_FABLE_STATE: path,
        TOKENLAYER_FABLE_EVENTS: dir + "/events",
        TOKENLAYER_HUB_URL: server.url.origin,
        CLICKHOUSE_URL: server.url.origin,
        CLIPROXY_MGMT_KEY: "fixture-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    return out ? JSON.parse(out) : undefined;
  };
  const stored = (): State => JSON.parse(readFileSync(path, "utf8"));
  try {
    expect((await run("set", "--account", "a")).applied).toBe("ON");
    await run("set", "--allow-non-fable-on-fable-account");
    expect(stored().requested.allowNonFableOnFableAccount).toBe(true);
    await run("set", "--protect-fable-reserve");
    expect(stored().requested.allowNonFableOnFableAccount).toBe(false);
    expect((await run("off")).applied).toBe("OFF");
    const n = hub.calls.length;
    const status = await run("status", "--json");
    expect(status.requested.mode).toBe("off");
    expect(status.applied).toBe("OFF");
    expect(hub.calls.length).toBe(n);
    // A replacement must be explicitly re-adopted and loses the old identity binding.
    hub.obs[1].auth_index = "new-index";
    expect((await run("status", "--json")).applied).toBe("UNKNOWN");
    await run("baseline", "adopt", "--credential", "b");
    expect(stored().baseline.b.auth_index).toBe("new-index");
    expect((await run("off")).applied).toBe("OFF");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});
