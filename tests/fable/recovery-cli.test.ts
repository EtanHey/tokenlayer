import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fakeHub, state } from "./fixtures";
import type { Fields } from "../../src/fable/core";

for (const mode of ["off", "manual"] as const) test(`spawned ${mode} daemon recovers reset B and leaves exhausted A cooled`, async () => {
  const hub = fakeHub(), s = state(), dir = mkdtempSync(tmpdir() + "/fable-recovery-");
  const reset = new Date(Date.now() + 3 * 86400000).toISOString();
  for (const c of hub.obs) {
    c.cooldowns = [{ scope: "model", model_key: "claude-fable-5-2", reason: "quota", retry_at: reset }];
    c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Utilization"] = "0.98";
    c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Status"] = "allowed_warning";
    c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Reset"] = String(Date.parse(reset) / 1000);
    c.model_quotas!["claude-fable-5-2"].signals!["Anthropic-Ratelimit-Unified-7d_oi-Status"] = "rejected";
  }
  s.mode = s.requested.mode = mode;
  s.applied = "OFF";
  s.resets = { b: { left: 2, confirmedByEtan: true } };
  writeFileSync(dir + "/state", JSON.stringify(s));
  const attempts: string[] = [], checks: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("");
    if (url.pathname.endsWith("/requests/api-call")) {
      const body = await req.json();
      expect(body).toEqual({ auth_index: body.auth_index, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" } });
      checks.push(body.auth_index);
      return Response.json({ status_code: 200, body: JSON.stringify({ seven_day: { utilization: body.auth_index === "a" ? 100 : 0, resets_at: reset }, five_hour: null }), header: {} });
    }
    if (url.pathname.endsWith("/routing/cooldown/reset")) {
      const { auth_index } = await req.json();
      attempts.push(auth_index);
      hub.obs.find(c => c.auth_index === auth_index)!.cooldowns = [];
      return Response.json({ status: "ok" });
    }
    if (url.pathname.endsWith("/credentials/models")) return Response.json({ models: (await hub.catalog(url.searchParams.get("name")!)).map(id => ({ id })) });
    if (url.pathname.includes("model-definitions")) return Response.json({ models: (await hub.registry()).map(id => ({ id })) });
    if (req.method === "PATCH") { const body = await req.json() as Fields & { name: string }; await hub.patch(body.name, body); return Response.json({ status: "ok" }); }
    return Response.json({ files: hub.obs.map(c => ({ ...c, provider: "claude", account_type: "oauth" })) });
  } });
  const p = Bun.spawn([process.execPath, "src/fable/main.ts", "run"], { env: { ...process.env, TOKENLAYER_ENV_FILES: "", TOKENLAYER_HUB_URL: server.url.origin, CLICKHOUSE_URL: server.url.origin, CLIPROXY_MGMT_KEY: "fixture", TOKENLAYER_FABLE_STATE: dir + "/state", TOKENLAYER_FABLE_EVENTS: dir + "/events" }, stdout: "pipe", stderr: "pipe" });
  try {
    // First output marks completion of a whole daemon tick; no race-forcing sleep.
    const reader = p.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(`"applied":"${mode === "off" ? "OFF" : "UNKNOWN"}"`);
    expect(attempts).toEqual(["b"]);
    expect(checks).toEqual(["a", "b"]);
    expect(hub.obs[0].cooldowns).toHaveLength(1);
    expect(hub.obs[1].cooldowns).toEqual([]);
    reader.releaseLock();
    p.kill(); await p.exited;
    const stored = () => JSON.parse(readFileSync(dir + "/state", "utf8"));
    expect(stored().resets.b).toEqual({ left: 2, confirmedByEtan: true });
    expect(hub.rules.b).toEqual([]);
    const once = async (command: string) => {
      const child = Bun.spawn([process.execPath, "src/fable/main.ts", command], { env: { ...process.env, TOKENLAYER_ENV_FILES: "", TOKENLAYER_HUB_URL: server.url.origin, CLICKHOUSE_URL: server.url.origin, CLIPROXY_MGMT_KEY: "fixture", TOKENLAYER_FABLE_STATE: dir + "/state", TOKENLAYER_FABLE_EVENTS: dir + "/events" }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0); expect(err).toBe(""); return JSON.parse(out);
    };
    const bytes = readFileSync(dir + "/state", "utf8");
    await once("status"); await once("plan");
    expect(readFileSync(dir + "/state", "utf8")).toBe(bytes);
    expect(checks).toEqual(["a", "b"]);
    hub.obs[1].cooldowns = [{ scope: "model", model_key: "claude-fable-5-2", reason: "quota", retry_at: reset }];
    await once("reconcile"); // Restart retains metadata cadence.
    expect(checks).toEqual(["a", "b"]); expect(attempts).toEqual(["b"]);
    const aged = stored();
    for (const r of Object.values(aged.recovery) as { checkedAt: number }[]) r.checkedAt -= 180000;
    writeFileSync(dir + "/state", JSON.stringify(aged));
    await once("reconcile"); // New metadata, same allowance: never clear a new real error again.
    expect(checks).toEqual(["a", "b", "a", "b"]); expect(attempts).toEqual(["b"]);
  } finally {
    p.kill(); await p.exited; server.stop(true); rmSync(dir, { recursive: true });
  }
});

test("G1 spawned daemon clears a directly recovered Fable cap below 90% shared usage", async () => {
  const hub = fakeHub(), s = state(), dir = mkdtempSync(tmpdir() + "/fable-direct-recovery-");
  const reset = new Date(Date.now() + 3 * 86400000).toISOString(), c = hub.obs[0];
  c.cooldowns = [{ scope: "model", model_key: "claude-fable-5-2", reason: "quota", retry_at: reset }];
  Object.assign(c.model_quotas!["claude-fable-5-2"].signals!, {
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.55",
    "Anthropic-Ratelimit-Unified-7d-Reset": String(Date.parse(reset) / 1000),
    "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
    "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "1",
  });
  writeFileSync(dir + "/state", JSON.stringify(s));
  const attempts: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/requests/api-call")) return Response.json({ status_code: 200, body: JSON.stringify({
      seven_day: { utilization: 2, resets_at: reset }, five_hour: null,
      limits: [
        { kind: "weekly_all", percent: 2, resets_at: reset, scope: null },
        { kind: "weekly_scoped", percent: 0, resets_at: reset, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
      ],
    }) });
    if (path.endsWith("/routing/cooldown/reset")) {
      attempts.push(await req.json()); c.cooldowns = []; return Response.json({ status: "ok" });
    }
    if (req.method === "PATCH") { const body = await req.json() as Fields & { name: string }; await hub.patch(body.name, body); return Response.json({ status: "ok" }); }
    return Response.json({ files: hub.obs.map(c => ({ ...c, provider: "claude", account_type: "oauth" })) });
  } });
  const p = Bun.spawn([process.execPath, "src/fable/main.ts", "reconcile"], { env: { ...process.env, TOKENLAYER_ENV_FILES: "", TOKENLAYER_HUB_URL: server.url.origin, CLICKHOUSE_URL: server.url.origin, CLIPROXY_MGMT_KEY: "fixture", TOKENLAYER_FABLE_STATE: dir + "/state", TOKENLAYER_FABLE_EVENTS: dir + "/events" }, stdout: "pipe", stderr: "pipe" });
  try {
    const [code, , err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(code).toBe(0); expect(err).toBe("");
    expect(attempts).toEqual([{ auth_index: "a" }]);
    expect(JSON.parse(readFileSync(dir + "/state", "utf8")).recovery.a.result).toBe("cleared");
  } finally {
    p.kill(); await p.exited; server.stop(true); rmSync(dir, { recursive: true });
  }
});
