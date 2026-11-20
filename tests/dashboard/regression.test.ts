import { fakeHub, state } from "../fable/fixtures";
import { writeFileSync } from "node:fs";
import { test, expect } from "bun:test";
import { createHandler, recommend } from "../../src/dashboard/server";
import { arrangement } from "../../src/dashboard/advice";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
const now = Date.now();
function account(weekly: any = {}, fable: any = {}) {
  return {
    email: "a",
    weekly: {
      utilization: 0.5,
      status: "allowed",
      reset: new Date(now + 48 * 3600000).toISOString(),
      stale: false,
      ...weekly,
    },
    fable: { utilization: null, status: "unknown", stale: true, ...fable },
  };
}
test("separate refill/rescue, mixed-case rejection, stale and unknown reset guidance", () => {
  expect(
    recommend(account({}, { utilization: 1, status: "REJECTED", stale: false }), {}, now).reason,
  ).toContain("(a)");
  const rescue = recommend(account({ status: "REJECTED", utilization: 1 }), {}, now);
  expect(rescue.reason).toContain("(b)");
  expect(rescue.reason).toContain("refund unknown, check Settings > Usage");
  expect(rescue.verdict).toBe("consider");
  expect(recommend(account({ reset: "invalid", status: "rejected" }), {}, now).reason).toContain(
    "could not be parsed",
  );
  expect(
    recommend(account({ reset: String((now + 30 * 3600000) / 1000), status: "rejected" }), {}, now).reason,
  ).toContain("Under 36 h");
  expect(recommend(account({ stale: true, status: "rejected", reset: "invalid" }), {}, now).verdict)
    .toBe("UNKNOWN");
  expect(recommend(account({}, { stale: false }), {}, now).verdict).toBe("wait");
});
test("a capped account's stale reading still names rule (b) until its reset", () => {
  // r5: one account's weekly was rejected, so it served no traffic and its reading went stale.
  const capped = recommend(account({ stale: true, status: "rejected", utilization: 1 },
    { utilization: 0.4, status: "allowed", stale: true }), {}, now);
  expect(capped.verdict).toBe("consider");
  expect(capped.reason).toContain("weekly cap reached");
  expect(capped.reason).toContain("(b)");
  expect(capped.reason).not.toContain("Observations stale");
  // Nothing to refund: never "consider", never "0% of week".
  const empty = recommend(account({ stale: true, status: "rejected", utilization: 1 },
    { utilization: 0, status: "allowed", stale: true }), {}, now);
  expect(empty.verdict).toBe("wait");
  expect(empty.reason).toContain("a reset refunds nothing now");
  expect(empty.reason).not.toContain("0% of week");
  // The reading's window has ended: the cap no longer proves anything.
  const ended = recommend(account({ stale: true, status: "rejected", utilization: 1,
    reset: new Date(now - 3600000).toISOString() }), {}, now);
  expect(ended.verdict).toBe("UNKNOWN");
  expect(ended.reason).not.toContain("weekly cap reached");
  expect(ended.reason).toContain("reset has passed");
});
test("the arrangement waits for a capped account's reset instead of calling it stale", () => {
  const meter = (u: number, stale = false, status = "allowed") =>
    ({ utilization: u, stale, status, reset: new Date(now + 30 * 3600000).toISOString() });
  const plan = arrangement([
    { email: "open", status: "active", weekly: meter(0.3), fable: meter(0.1) },
    { email: "capped", status: "active", weekly: meter(1, true, "rejected"), fable: meter(0, true) },
  ], now);
  expect(plan.keepOff).toBe(true);
  expect(plan.reason).not.toContain("stale");
  expect(plan.reason).toContain("Keep OFF until capped resets");
});
test("HTTP writes, replay, validation, isolated history and environment key canaries", async () => {
  const dir = mkdtempSync(tmpdir() + "/dash-regression-");
  const canaries = ["fake-management-123", "fake-clickhouse-456", "fake-access-789"];
  const names = ["CLIPROXY_MGMT_KEY", "CLICKHOUSE_PASSWORD", "OPENAI_API_KEY"];
  const prior = names.map((n) => process.env[n]);
  names.forEach((n, i) => (process.env[n] = canaries[i]));
  let calls = 0;
  const fixture = fakeHub();
  const hub: any = { ...fixture, request: async () => { calls++; } };
  const initial = state();
  writeFileSync(dir + "/state", JSON.stringify(initial));
  const handler = createHandler({
    logins: ["owner"],
    origin: "https://dash.test",
    secret: "secret",
    path: dir + "/state",
    events: dir + "/events",
    hub,
    ch: { queryJSON: async () => [] },
  });
  const headers = {
    "Tailscale-User-Login": "owner",
    Origin: "https://dash.test",
    "X-CSRF-Token": createHmac("sha256", "secret").update("owner").digest("hex"),
    "Content-Type": "application/json",
  };
  async function request(path: string, body?: any, extra = {}) {
    const r = await handler(
      new Request("https://dash.test/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, ...extra },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    const text = await r.text();
    for (const key of canaries) expect(text).not.toContain(key);
    return { status: r.status, data: JSON.parse(text.startsWith("<") ? "{}" : text) };
  }
  try {
    for (const path of [
      "",
      "api/state",
      "api/accounts",
      "api/metrics",
      "api/burn",
      "api/recommendation",
      "missing",
    ])
      await request(path);
    expect((await request("api/resets", "{")).status).toBe(400);
    expect((await request("api/resets", " ".repeat(8200))).status).toBe(413);
    expect((await request("api/resets", {}, { "Content-Type": "text/plain" })).status).toBe(415);
    for (const mode of ["off", "manual"])
      expect(
        (await request("api/switch", { account: {}, mode, strict: true, spillover: false })).status,
      ).toBe(400);
    expect(
      (
        await request("api/switch", {
          account: "a",
          on: false,
          strict: true,
          spillover: false,
          opId: "off",
        })
      ).status,
    ).toBe(200);
    expect((await request("api/resets", { account: "a", left: 2, confirmed: true })).status).toBe(200);
    const press = { account: "a", opId: "press" };
    expect((await request("api/reset-pressed", press)).status).toBe(200);
    expect((await request("api/reset-pressed", press)).data.state.resets.a.left).toBe(1);
    expect(calls).toBe(1);
    expect((await request("api/reset-pressed", { account: "b", opId: "press" })).status).toBe(503);
    const events = readFileSync(dir + "/events", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(6);
    expect(events.every((e) => e.who === "owner")).toBe(true);
    const empty = createHandler({ logins: [], origin: "x", secret: "x", hub, ch: {} as any });
    expect((await empty(new Request("https://dash.test/", { headers }))).status).toBe(403);
    for (const path of ["/", "/api/state"])
      expect((await handler(new Request("https://dash.test" + path))).status).toBe(403);
    hub.observations = async () => {
      throw Error(canaries.join(" "));
    };
    for (const path of ["api/accounts", "api/metrics", "api/burn", "api/recommendation"])
      expect((await request(path)).status).toBe(503);
  } finally {
    names.forEach((n, i) => (prior[i] === undefined ? delete process.env[n] : (process.env[n] = prior[i])));
    rmSync(dir, { recursive: true });
  }
});
