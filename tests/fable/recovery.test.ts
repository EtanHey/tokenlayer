import { test, expect } from "bun:test";
import { reconcile } from "../../src/fable/recovery";
import { plan, usable, type Observation } from "../../src/fable/core";
import { observed, state, models } from "./fixtures";
const now = Date.now(), reset = new Date(now + 3 * 86400000).toISOString();
function fixture() {
  let s = state(), time = now, checks = 0, posts = 0, saved = "", fail = false, clear = true, loseResponse = false;
  let response: unknown = { status_code: 200, body: JSON.stringify({ seven_day: { utilization: 0, resets_at: reset }, five_hour: null }) };
  const c = observed("a", 0.98, 1), obs = [c, observed("b")];
  c.quota!.observed_at = new Date(now - 1000).toISOString();
  c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Reset"] = String(Date.parse(reset) / 1000);
  c.model_quotas![models[0]].signals!["Anthropic-Ratelimit-Unified-7d_oi-Status"] = "rejected";
  c.cooldowns = [{ scope: "model", model_key: models[0], reason: "quota", retry_at: reset }];
  s.resets = { a: { left: 2, confirmedByEtan: true } };
  let during = async () => {};
  const hub = {
    observations: async () => structuredClone(obs),
    request: async (_method: string, path: string, body?: unknown) => {
      if (path === "/requests/api-call") { checks++; await during(); if (fail) throw Error("private provider failure"); return response; }
      expect(path).toBe("/routing/cooldown/reset");
      expect(body).toEqual({ auth_index: "a" });
      expect(JSON.parse(saved).recovery.a.result).toBe("attempted");
      posts++; if (clear) { c.cooldowns = []; c.unavailable = false; }
      if (loseResponse) throw Error("response lost");
      return {};
    },
  };
  return { c, obs, hub, get s() { return s; }, get checks() { return checks; }, get posts() { return posts; },
    set response(v: unknown) { response = v; }, set fail(v: boolean) { fail = v; }, set clear(v: boolean) { clear = v; }, set loseResponse(v: boolean) { loseResponse = v; },
    set during(v: () => Promise<void>) { during = v; }, advance() { time += 180000; }, restart() { s = JSON.parse(saved); },
    async run() { await reconcile(s, hub, () => { saved = JSON.stringify(s); }, () => time); },
    usage(u: unknown, extras: Record<string, unknown> = {}) { response = { status_code: 200, body: JSON.stringify({ seven_day: { utilization: u, resets_at: reset }, five_hour: null, ...extras }) }; },
  };
}

test("drop clears exact cache, preserves inventory, masks stale rejection under ON as UNKNOWN", async () => {
  const f = fixture(); f.c.unavailable = true;
  await f.run();
  expect(f.posts).toBe(1); expect(f.s.recovery!.a.result).toBe("cleared");
  expect(f.s.resets!.a).toEqual({ left: 2, confirmedByEtan: true });
  const p = plan(f.s, f.obs);
  expect(p.applied).toBe("UNKNOWN");
  expect(p.desired.a.excluded_models).toBeNull(); expect(p.desired.b.excluded_models).toBeNull();
  expect(usable(f.s, f.c, models[0])).toBe(false); // UNKNOWN capacity, never fabricated usable.
  f.c.quota = structuredClone(f.c.quota);
  f.c.quota!.observed_at = new Date(now + 1).toISOString();
  f.c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Utilization"] = "0";
  expect(plan(f.s, f.obs).desired.b.excluded_models).toBeNull(); // Stale model cap cannot restrict B.
  f.c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Utilization"] = "0.98";
  f.c.model_quotas = { [models[0]]: f.c.quota! };
  expect(plan(f.s, f.obs).applied).toBe("ON_WAIT_AT_CAP"); // New real rejection is binding.
});

for (const value of [98, 100, 60, 49, null, "0", -1, 101]) test(`unchanged, small drop or invalid weekly ${value} never clears`, async () => {
  const f = fixture(); f.usage(value); await f.run(); expect(f.posts).toBe(0);
});
for (const body of ['{"seven_day":{"utilization":0,"resets_at":"2027-02-30T00:00:00Z"}}', "private not json", "null", "{}", '{"seven_day":null}', '{"seven_day":{"utilization":0,"resets_at":"bad"}}']) test(`malformed metadata remains UNKNOWN: ${body}`, async () => {
  const f = fixture(); f.response = { status_code: 200, body }; await f.run();
  expect(f.posts).toBe(0); expect(f.s.recovery!.a.result).toBe("unknown");
});
for (const status_code of [401, 429, 500]) test(`provider status ${status_code} never clears`, async () => {
  const f = fixture(); f.response = { status_code, body: "private response", header: { Authorization: "private" } }; await f.run(); expect(f.posts).toBe(0);
});
for (const five_hour of [{ utilization: 100, resets_at: reset }, { utilization: "0", resets_at: reset }, { utilization: 0, resets_at: "bad" }]) test("present exhausted or invalid 5h prevents recovery", async () => {
  const f = fixture(); f.usage(0, { five_hour }); await f.run(); expect(f.posts).toBe(0);
});
for (const change of [
  (c: Observation) => { c.disabled = true; },
  (c: Observation) => { c.status = "error"; },
  (c: Observation) => { c.status = "error"; c.status_message = '{"error":{"type":"authentication_error"}}'; },
  (c: Observation) => { c.status = "error"; c.status_message = "rate_limit_error: quota"; c.cooldowns![0].retry_at = new Date(now + 60000).toISOString(); },
  (c: Observation) => { c.cooldowns![0].reason = "rate_limit"; },
  (c: Observation) => { c.cooldowns![0].scope = "auth"; },
  (c: Observation) => { c.cooldowns![0].retry_at = new Date(now + 60000).toISOString(); },
  (c: Observation) => { c.auth_index = "replacement"; },
]) test("disabled, auth, transient and unadopted identities never probed or cleared", async () => {
  const f = fixture(); change(f.c); await f.run(); expect(f.checks).toBe(0); expect(f.posts).toBe(0);
});
for (const change of [
  (c: Observation) => { c.auth_index = "replacement"; },
  (c: Observation) => { c.id = "replacement"; },
  (c: Observation) => { c.disabled = true; },
  (c: Observation) => { c.cooldowns![0].retry_at = new Date(now + 4 * 86400000).toISOString(); },
  (c: Observation) => { c.quota!.observed_at = new Date(now).toISOString(); },
  (c: Observation) => { c.model_quotas = {}; },
]) test("metadata await race invalidates admission before reset", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  f.during = async () => { entered.resolve(); await resume.promise; };
  const running = f.run(); await entered.promise; change(f.c); resume.resolve(); await running;
  expect(f.posts).toBe(0); expect(f.s.recovery!.a.result).toBe("stale");
});

test("durable cadence also bounds provider failures across restart", async () => {
  const f = fixture(); f.fail = true;
  await f.run(); f.restart(); await f.run(); expect(f.checks).toBe(1);
  f.advance(); await f.run(); expect(f.checks).toBe(2); expect(f.posts).toBe(0);
});
test("new real quota error on same allowance cannot trigger another recovery after restart", async () => {
  const f = fixture(); f.clear = false;
  await f.run(); expect(f.s.recovery!.a.result).toBe("unconfirmed");
  f.restart(); f.advance(); f.c.quota!.observed_at = new Date(now).toISOString();
  await f.run(); expect(f.checks).toBe(2); expect(f.posts).toBe(1);
  expect(f.s.recovery!.a.attempted!.outcome).toBe("unconfirmed");
});
test("failed clear retains cap evidence and WAIT_AT_CAP without spilling to B", async () => {
  const f = fixture(); f.clear = false;
  f.c.quota!.observed_at = new Date(now - 2 * 86400000).toISOString();
  expect(plan(f.s, f.obs, now).applied).toBe("ON_WAIT_AT_CAP");
  await f.run();
  expect(f.s.recovery!.a.result).toBe("unconfirmed");
  expect(f.c.cooldowns).toHaveLength(1);
  const after = plan(f.s, f.obs, now);
  expect(after.applied).toBe("ON_WAIT_AT_CAP");
  expect(after.desired.b.excluded_models).toEqual(["claude-fable-*"]);
});
test("natural reset advancement with fresh headroom qualifies", async () => {
  const f = fixture();
  f.c.quota!.observed_at = new Date(now - 86400000).toISOString();
  f.c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Reset"] = String((now - 1000) / 1000);
  f.usage(20, { five_hour: { utilization: 20, resets_at: reset } });
  await f.run(); expect(f.posts).toBe(1);
});
test("lost reset response is cleared only by exact readback", async () => {
  const f = fixture(); f.loseResponse = true; await f.run();
  expect(f.posts).toBe(1); expect(f.s.recovery!.a.result).toBe("cleared");
});

for (const key of ["quota", "weekly signals"] as const) test(`missing ${key} cannot fabricate a weekly reset`, async () => {
  const f = fixture();
  if (key === "quota") f.c.quota = null;
  else { f.c.quota!.signals = { "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "1" }; }
  await f.run(); expect(f.posts).toBe(0);
});
test("replacement in post-reset readback cannot be certified cleared", async () => {
  const f = fixture(), request = f.hub.request;
  f.hub.request = async (...args) => { const result = await request(...args); if (args[1].endsWith("/reset")) f.c.auth_index = "replacement"; return result; };
  await f.run(); expect(f.s.recovery!.a.result).toBe("unconfirmed");
});

test("usage window subsecond formatting and countdown drift do not hide a reset", async () => {
  const f = fixture(), r = Date.parse(reset);
  f.c.quota!.signals!["Anthropic-Ratelimit-Unified-7d-Reset"] = String(Math.floor(r / 1000));
  f.during = async () => { (f.c.cooldowns![0] as {remaining_seconds?: number}).remaining_seconds = 7000; };
  await f.run(); expect(f.posts).toBe(1);
});

for (const message of ["quota exhausted", "rate_limit_error: Account rate limit exceeded", '{"error":{"type":"rate_limit_error"}}']) test("quota-exhausted error status can recover while auth errors remain blocked", async () => {
  const f = fixture();
  Object.assign(f.c, {status: "error", status_message: message, unavailable: true});
  f.c.cooldowns!.forEach(c => Object.assign(c, {http_status: 429}));
  const request = f.hub.request;
  f.hub.request = async (...args) => { const result = await request(...args); if(args[1].endsWith("/reset")) f.c.status = "active"; return result; };
  await f.run(); expect(f.posts).toBe(1); expect(f.s.recovery!.a.result).toBe("cleared");
});
