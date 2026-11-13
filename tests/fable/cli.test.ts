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
      if (url.pathname.includes("model-definitions"))
        return Response.json({
          models: (await hub.registry()).map((id) => ({ id })),
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
  const invoke = async (...args: string[]) => {
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
    return { code, out, err };
  };
  const run = async (...args: string[]) => {
    const { code, out, err } = await invoke(...args);
    expect(err).toBe(""); expect(code).toBe(0);
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
    await run("set", "--no-spillover");
    await run("off", "--auto-spillover", "--strict", "--allow-non-fable-on-fable-account");
    expect(stored().spillover).toBe("auto");
    expect(stored().requested.spillover).toBe("auto");
    expect(stored().strictFableAccount).toBe(true);
    expect(stored().requested.allowNonFableOnFableAccount).toBe(true);
    expect(stored().mode).toBe("off"); expect(stored().applied).toBe("OFF");
    await run("resets", "set", "--account", "a", "--left", "2", "--confirmed");
    expect(stored().resets).toEqual({ a: { left: 2, confirmedByEtan: true } });
    for (const args of [
      ["--account", "missing", "--left", "2", "--confirmed"],
      ["--account", "a", "--left", "-1", "--confirmed"],
      ["--account", "a", "--left", "1.5", "--confirmed"],
      ["--account", "a", "--left", "2"],
    ]) {
      const before = readFileSync(path, "utf8");
      expect((await invoke("resets", "set", ...args)).code).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    const n = hub.calls.length;
    const status = await run("status", "--json");
    expect(status.requested.mode).toBe("off");
    expect(status.applied).toBe("OFF");
    expect(Array.isArray(status.policy.desired)).toBe(true);
    expect(
      status.policy.desired.map((x: { account: number }) => x.account),
    ).toEqual([0, 1]);
    expect(status.baseline).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("auth_index");
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
