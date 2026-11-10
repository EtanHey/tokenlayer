import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fakeHub, models, state } from "./fixtures";
import type { Fields, State } from "../../src/fable/core";

for (const drift of ["added", "retired", "unreachable"]) {
  test(`OFF persists before network and recovers from ${drift}`, async () => {
    const hub = fakeHub(),
      s = state(),
      dir = mkdtempSync(tmpdir() + "/fable-off-");
    const path = dir + "/state",
      calls: unknown[] = [];
    s.requested = { ...s.requested, mode: "manual" };
    s.pending = {
      op: "old-on",
      plan: { desired: {}, applied: "ON", reason: "old", exceptions: {} },
    };
    hub.rules.b = ["claude-fable-*"];
    hub.obs[0].priority = 50;
    hub.obs[1].priority = 100;
    const current =
      drift === "added"
        ? [...models, "claude-fable-new"]
        : drift === "retired"
          ? models.filter((m) => m !== models[2])
          : models;
    writeFileSync(path, JSON.stringify(s));
    let savedBeforeNetwork = true;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") return new Response("");
        const persisted = JSON.parse(readFileSync(path, "utf8"));
        savedBeforeNetwork &&= persisted.requested.mode === "off";
        if (url.pathname.includes("model-definitions"))
          return Response.json({ models: current.map((id) => ({ id })) });
        if (url.pathname.endsWith("/credentials/models")) {
          const id = url.searchParams.get("name")!;
          return Response.json({
            models: current
              .filter(
                (m) =>
                  !hub.rules[id].some(
                    (r) =>
                      r === m ||
                      (r === "claude-fable-*" && m.startsWith("claude-fable-")),
                  ),
              )
              .map((id) => ({ id })),
          });
        }
        if (req.method === "PATCH") {
          const body = (await req.json()) as Fields & { name: string };
          calls.push(body);
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
    const env = {
      ...process.env,
      TOKENLAYER_ENV_FILES: "",
      TOKENLAYER_FABLE_STATE: path,
      TOKENLAYER_FABLE_EVENTS: dir + "/events",
      TOKENLAYER_HUB_URL: server.url.origin,
      CLICKHOUSE_URL: server.url.origin,
      CLIPROXY_MGMT_KEY: "fixture-key",
    };
    const spawn = (cmd: string, url = server.url.origin) =>
      Bun.spawn([process.execPath, "src/fable/main.ts", cmd], {
        env: { ...env, TOKENLAYER_HUB_URL: url },
        stdout: "pipe",
        stderr: "pipe",
      });
    try {
      const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
      const unreachable = closed.url.origin;
      closed.stop(true);
      const proc = spawn(
        "off",
        drift === "unreachable" ? unreachable : server.url.origin,
      );
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(JSON.parse(readFileSync(path, "utf8")).requested.mode).toBe("off");
      if (drift === "unreachable") {
        expect(code).toBe(3);
        expect(out + err).toContain(
          "OFF requested and saved; it will apply as soon as the hub is reachable",
        );
        expect(calls).toEqual([]);
        // Force a conflicting legacy mirror: durable requested OFF must win on the next daemon tick.
        const persisted = JSON.parse(readFileSync(path, "utf8"));
        persisted.mode = "manual";
        writeFileSync(path, JSON.stringify(persisted));
        const daemon = spawn("run");
        try {
          const reader = daemon.stdout.getReader();
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value)).toContain(
            '"applied":"OFF"',
          );
          await reader.cancel();
        } finally {
          daemon.kill();
          await daemon.exited;
        }
      } else {
        expect(code).toBe(0);
        expect(JSON.parse(out).applied).toBe("OFF");
      }
      expect(savedBeforeNetwork).toBe(true);
      expect((JSON.parse(readFileSync(path, "utf8")) as State).applied).toBe(
        "OFF",
      );
      expect(hub.rules).toEqual({ a: [], b: [] });
      expect(hub.obs.every((c) => !Object.hasOwn(c, "priority"))).toBe(true);
      expect(calls).toHaveLength(2);
      expect(
        hub.calls.every(
          (c) =>
            c.fields.excluded_models === null && c.fields.priority === null,
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true });
    }
  }, 15000);
}

test("OFF readback rejects hidden exclusions even when both catalogs omit the same registry Fable", async () => {
  const { offReadback } = await import("../../src/fable/off");
  const s = state(),
    hub = fakeHub();
  hub.rules.a = hub.rules.b = ["claude-fable-*"];
  await expect(offReadback(s, hub)).rejects.toThrow("OFF readback unconfirmed");
  hub.rules.a = hub.rules.b = [];
  hub.obs[0].priority = null;
  await expect(offReadback(s, hub)).rejects.toThrow("OFF readback unconfirmed");
  delete hub.obs[0].priority;
  expect(await offReadback(s, hub)).toHaveLength(2);
});
