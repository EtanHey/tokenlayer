// D2: the "All tools" panel. One row per tool (Claude per account, Codex, Cursor, Antigravity, Kiro),
// with % used, reset, 24 h / 7 d use and a STALE / UNKNOWN mark. Vendor readings come from the M4's
// usage.json over ssh (cached); Claude readings come from the hub and the M1's proxy_usage.
import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fakeHub, observed } from "../fable/fixtures";
import { createHandler } from "../../src/dashboard/server";
import { m4Usage, toolRows, claudeUseSQL, M4_USAGE_REMOTE, type Probe } from "../../src/dashboard/tools";
import { labelHash } from "../../src/lib/hash";

const dir = import.meta.dir + "/fixtures/all-tools/";
const NOW = Date.parse("2026-11-19T21:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** usage-fresh.json written `ageMs` before NOW (its readings observed at the same moment). */
function usage(ageMs = 0) {
  const at = NOW - ageMs;
  return readFileSync(dir + "usage-fresh.json", "utf8")
    .replaceAll("__NOW__", iso(at))
    .replaceAll("__IN_3H__", iso(NOW + 3 * 3600_000))
    .replaceAll("__IN_6D__", iso(NOW + 6 * 86400_000));
}
const probe = (name: string): Probe => JSON.parse(readFileSync(dir + name, "utf8"));
const ok = (ageMs = 0): Probe => ({ exitCode: 0, stdout: usage(ageMs), stderr: "" });
function reader(...probes: Probe[]) {
  let t = NOW;
  const calls: string[] = [];
  const read = m4Usage(async (remote) => { calls.push(remote); return probes.shift()!; }, { ttlMs: 60_000, now: () => t });
  return { read, calls, advance: (ms: number) => (t += ms) };
}
const claude = () => [observed("a", 0.85, 0.54), observed("b", 0.2, 0.1)];
const claudeUse = [
  { credential: labelHash("a"), r1: 12, r7: 340, t1: 50_000, t7: 9_000_000 },
];
const byTool = (rows: ReturnType<typeof toolRows>) => Object.fromEntries(rows.map((r) => [r.name, r]));

test("fresh: one row per tool, Claude per account, each with %, reset and 24 h / 7 d use", async () => {
  const m = reader(ok());
  const rows = toolRows({ m4: await m.read(), claude: claude(), claudeUse, now: NOW });
  expect(rows.map((r) => r.name)).toEqual(["Claude · a", "Claude · b", "Codex", "Cursor", "Antigravity", "Kiro"]);
  const t = byTool(rows);
  expect(t["Claude · a"]).toMatchObject({ mark: "OK", pct: 85, window: "7d" });
  expect(t["Claude · a"].use?.["24h"]).toEqual({ sessions: null, requests: 12, tokens: 50_000, credits: null });
  expect(t["Claude · a"].use?.["7d"]?.requests).toBe(340);
  expect(t["Claude · b"].use?.["24h"]).toEqual({ sessions: null, requests: 0, tokens: 0, credits: null });
  expect(t.Codex).toMatchObject({ mark: "OK", pct: 100, window: "7d", resets_at: iso(NOW + 3 * 3600_000) });
  expect(t.Codex.use?.["7d"]).toEqual({ sessions: 948, requests: 38940, tokens: 124343011 + 19340905, credits: null });
  expect(t.Cursor).toMatchObject({ mark: "OK", use: null });
  expect(Math.round(t.Cursor.pct!)).toBe(54);
  expect(t.Antigravity.use?.["24h"]?.tokens).toBe(740808 + 69926);
  // Kiro publishes no quota: UNKNOWN %, but its credits still show.
  expect(t.Kiro).toMatchObject({ mark: "UNKNOWN", pct: null });
  expect(t.Kiro.why).toContain("usage unavailable");
  expect(t.Kiro.use?.["7d"]).toEqual({ sessions: 1, requests: 89, tokens: null, credits: 9.185065499834161 });
  // The remote reads only the usage file, and says when it is missing.
  expect(m.calls).toEqual([M4_USAGE_REMOTE]);
  expect(M4_USAGE_REMOTE).toContain("__MISSING__");
});

test("stale: an old usage.json marks every vendor row STALE with its age; Claude stays live", async () => {
  const rows = toolRows({ m4: await reader(ok(40 * 60_000)).read(), claude: claude(), claudeUse, now: NOW });
  const t = byTool(rows);
  for (const name of ["Codex", "Cursor", "Antigravity"]) {
    expect(t[name].mark).toBe("STALE");
    expect(t[name].why).toContain("40 min old");
    expect(t[name].pct).not.toBeNull(); // the old number still shows, marked
  }
  expect(t.Kiro.mark).toBe("UNKNOWN");
  expect(t["Claude · a"].mark).toBe("OK");
});

test("stale: a vendor whose own reading is stale is STALE even in a fresh file", async () => {
  const fresh = JSON.parse(usage());
  fresh.vendors.cursor.stale = true;
  fresh.vendors.cursor.observed_at = iso(NOW - 25 * 60_000);
  const rows = toolRows({ m4: await reader({ exitCode: 0, stdout: JSON.stringify(fresh), stderr: "" }).read(),
    claude: claude(), claudeUse, now: NOW });
  expect(byTool(rows).Cursor).toMatchObject({ mark: "STALE" });
  expect(byTool(rows).Cursor.why).toContain("25 min old");
  expect(byTool(rows).Codex.mark).toBe("OK");
});

test("missing: the M4 is awake but has no usage.json → vendor rows UNKNOWN, saying so", async () => {
  const snap = await reader(probe("probe-missing.json")).read();
  expect(snap.state).toBe("missing");
  const t = byTool(toolRows({ m4: snap, claude: claude(), claudeUse, now: NOW }));
  for (const name of ["Codex", "Cursor", "Antigravity", "Kiro"]) {
    expect(t[name]).toMatchObject({ mark: "UNKNOWN", pct: null, use: null });
    expect(t[name].why).toContain("usage.json missing");
  }
});

test("missing: a vendor absent from the file is its own UNKNOWN row", async () => {
  const fresh = JSON.parse(usage());
  delete fresh.vendors.antigravity;
  const t = byTool(toolRows({ m4: await reader({ exitCode: 0, stdout: JSON.stringify(fresh), stderr: "" }).read(),
    claude: claude(), claudeUse, now: NOW }));
  expect(t.Antigravity).toMatchObject({ mark: "UNKNOWN", pct: null });
  expect(t.Antigravity.why).toContain("not in usage.json");
});

test("asleep M4: the last good reading is served STALE with its age; ssh is not retried inside the TTL", async () => {
  const m = reader(ok(), probe("probe-asleep.json"));
  expect((await m.read()).state).toBe("fresh");
  m.advance(30_000);
  await m.read();
  expect(m.calls.length).toBe(1); // cached
  m.advance(15 * 60_000);
  const snap = await m.read();
  expect(m.calls.length).toBe(2);
  expect(snap.state).toBe("asleep");
  expect(snap.fetched_at).toBe(NOW);
  const t = byTool(toolRows({ m4: snap, claude: claude(), claudeUse, now: NOW + 15.5 * 60_000 }));
  for (const name of ["Codex", "Cursor", "Antigravity"]) {
    expect(t[name].mark).toBe("STALE");
    expect(t[name].why).toContain("M4 asleep");
    expect(t[name].why).toContain("15 min");
  }
  expect(t.Codex.pct).toBe(100);
});

test("asleep M4 with no reading yet, or a refused key: UNKNOWN, never a made-up number", async () => {
  for (const [file, words] of [["probe-asleep.json", "M4 asleep"], ["probe-refused.json", "ssh failed"]]) {
    const snap = await reader(probe(file)).read();
    const t = byTool(toolRows({ m4: snap, claude: claude(), claudeUse, now: NOW }));
    for (const name of ["Codex", "Cursor", "Antigravity", "Kiro"]) {
      expect(t[name]).toMatchObject({ mark: "UNKNOWN", pct: null });
      expect(t[name].why).toContain(words);
    }
  }
});

test("Claude: a stale or missing hub reading is marked; a failed use query leaves use null", async () => {
  const stale = observed("a", 0.85, 0.5);
  stale.quota!.observed_at = iso(NOW - 20 * 60_000);
  const blank = observed("b");
  blank.quota = undefined as any;
  const t = byTool(toolRows({ m4: await reader(ok()).read(), claude: [stale, blank], claudeUse: null, now: NOW }));
  expect(t["Claude · a"]).toMatchObject({ mark: "STALE", pct: 85, use: null });
  expect(t["Claude · a"].why).toContain("20 min old");
  expect(t["Claude · b"]).toMatchObject({ mark: "UNKNOWN", pct: null });
});

test("Claude use is bounded to 7 days of Claude hub traffic", () => {
  expect(claudeUseSQL).toContain("INTERVAL 7 DAY");
  expect(claudeUseSQL).toContain("provider = 'claude'");
  expect(claudeUseSQL).toContain("max_execution_time");
});

test("GET /api/tools serves the rows and the M4 state; no account labels or raw file leak", async () => {
  const tmp = mkdtempSync(tmpdir() + "/dash-tools-");
  try {
    const hub = fakeHub();
    const m = reader(ok(5 * 60_000));
    const handler = createHandler({
      logins: ["etan"], origin: "https://x", secret: "s", hub: hub as any,
      ch: { queryJSON: async (sql: string) => (sql === claudeUseSQL ? claudeUse : []) as any },
      path: tmp + "/state.json", events: tmp + "/events.jsonl",
      m4: m.read,
    });
    const r = await handler(new Request("https://x/api/tools", { headers: { "Tailscale-User-Login": "etan" } }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rows.map((x: any) => x.name)).toEqual(["Claude · a", "Claude · b", "Codex", "Cursor", "Antigravity", "Kiro"]);
    expect(body.m4).toMatchObject({ state: "fresh", generated_at: iso(NOW - 5 * 60_000) });
    expect(JSON.stringify(body)).not.toContain("fixture-account@example.test");
    const denied = await handler(new Request("https://x/api/tools"));
    expect(denied.status).toBe(403);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hub down: one Claude UNKNOWN row, and the vendor rows still show", async () => {
  const tmp = mkdtempSync(tmpdir() + "/dash-tools-");
  try {
    const hub = { ...fakeHub(), observations: async () => { throw Error("hub transport failure"); } };
    const handler = createHandler({
      logins: ["etan"], origin: "https://x", secret: "s", hub: hub as any,
      ch: { queryJSON: async () => [] as any }, path: tmp + "/state.json", events: tmp + "/events.jsonl",
      m4: reader(ok()).read,
    });
    const r = await handler(new Request("https://x/api/tools", { headers: { "Tailscale-User-Login": "etan" } }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rows.map((x: any) => x.name)).toEqual(["Claude", "Codex", "Cursor", "Antigravity", "Kiro"]);
    expect(body.rows[0]).toMatchObject({ mark: "UNKNOWN", pct: null, why: "hub readback unavailable" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('display-time expiry marks vendor and Claude readings stale at the reset boundary', async () => {
  const fresh = JSON.parse(usage());
  fresh.vendors.codex.resets_at = iso(NOW);
  const c = observed('a', 0.85, 0.5);
  c.quota!.observed_at = iso(NOW);
  c.quota!.signals['anthropic-ratelimit-unified-7d-reset'] = String(NOW / 1000);
  const t = byTool(toolRows({ m4: await reader({ exitCode: 0, stdout: JSON.stringify(fresh), stderr: '' }).read(),
    claude: [c], claudeUse, now: NOW }));
  for (const name of ['Codex', 'Claude · a']) {
    expect(t[name].mark).toBe('STALE');
    expect(t[name].why).toContain('reset has passed');
  }
  expect(t.Cursor.mark).toBe('OK');
});
