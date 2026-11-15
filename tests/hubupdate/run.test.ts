import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const runMod = () => import("../../src/hubupdate/run");
const targetMod = () => import("../../src/hubupdate/target");
const gateMod = () => import("../../src/hubupdate/gate");

import { ACCESS, MGMT, World, broken, flat, ok, peek, seed, setup, state } from "./world";

// Criterion 1: disabled means a full dry run that touches nothing.
test("disabled: records would_upgrade_now and never upgrades, restarts, links or copies", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(false);
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ mode: "dry_run", decision: "would_upgrade_now", installed: "8.0.64", available: "8.0.70", gate: { verdict: "idle", signal: "in_flight" } });
  expect(w.mutations()).toEqual([]); expect(state(dir).last.decision).toBe("would_upgrade_now");
  expect(existsSync(dir + "/state/backups")).toBe(false);
  rmSync(dir, { recursive: true });
});
test("enable file must say exactly enabled", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(false);
  writeFileSync(dir + "/enabled", "yes\n");
  expect((await run(w.deps(), target)).mode).toBe("dry_run"); expect(w.mutations()).toEqual([]);
  rmSync(dir, { recursive: true });
});

// Criterion 2: each refusal, enabled, with nothing touched.
for (const [name, configure, decision, seeded] of [
  ["up to date", (w: World) => { w.stable = "8.0.64"; }, "up_to_date", undefined],
  ["linked newer than stable", (w: World) => { w.stable = "8.0.63"; }, "up_to_date", undefined],
  ["version recorded as failed", () => {}, "version_failed", { failed: { "8.0.70": { at: "2026-11-14T00:00:00Z", reason: "probe_failed", step: "probing" } } }],
  ["refresh failed", (w: World) => { w.fail.add("brew update"); }, "refresh_failed", undefined],
  ["successful upgrade inside 24 h", () => {}, "rate_limited", { lastSuccessAt: "2026-11-14T09:00:00Z" }],
  ["metadata unreadable", (w: World) => { w.fail.add("brew info"); }, "busy_unknown", undefined],
  ["running process is not the linked keg", (w: World) => { w.running = { pid: 100, version: "8.0.45" }; }, "running_mismatch", undefined],
  ["halted after a failed rollback", () => {}, "halted", { halted: { at: "2026-11-14T00:00:00Z", reason: "rollback_failed" } }],
] as const) test(`refuses without touching anything: ${name}`, async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, configure as (w: World) => void);
  if (seeded) seed(dir, seeded);
  const out = await run(w.deps(), target);
  expect(out.decision).toBe(decision); expect(w.mutations()).toEqual([]);
  expect(JSON.stringify(out) + readFileSync(dir + "/state/state.json", "utf8")).not.toContain("PRIVATE");
  expect(w.calls.some(a => a[0] === "GET")).toBe(false); // every refusal here comes before the idle gate
  rmSync(dir, { recursive: true });
});
test("rate limit expires after 24 h", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true);
  seed(dir, { lastSuccessAt: "2026-11-14T07:59:00Z" });
  expect((await run(w.deps(), target)).decision).toBe("upgraded");
  rmSync(dir, { recursive: true });
});

// Criterion 3: idle gate.
test("gate: in_flight must be 0 on every poll of the confirmation window; a busy poll restarts the window", async () => {
  const { gate } = await gateMod(); const { hubTarget } = await targetMod(); const w = new World("");
  const seq = [0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  w.inflight = n => ({ status: 200, body: JSON.stringify({ in_flight: seq[n] ?? 0, by_provider: {} }) });
  const t = hubTarget("/home/x"); const g = await gate(w.deps() as never, t, MGMT, { confirmMs: 20000, pollMs: 2000, waitMs: 240000 });
  expect(g).toMatchObject({ verdict: "idle", signal: "in_flight", nonZeroPolls: 1, maxInFlight: 3 });
  expect(g.polls).toBe(14); // 3 polls before the reset, then 11 zero polls spanning 20 s
});
test("gate: busy for the whole wait budget is busy; waits at most the budget", async () => {
  const { gate } = await gateMod(); const { hubTarget } = await targetMod(); const w = new World(""); const start = w.clock;
  w.inflight = () => ({ status: 200, body: JSON.stringify({ in_flight: 2, oldest_started_at: "2026-11-15T07:02:03Z", by_provider: { claude: 2 } }) });
  const g = await gate(w.deps() as never, hubTarget("/h"), MGMT, { confirmMs: 20000, pollMs: 2000, waitMs: 240000 });
  expect(g.verdict).toBe("busy"); expect(w.clock - start).toBeLessThanOrEqual(240000); expect(g.polls).toBeGreaterThan(100);
});
for (const [name, resp, reason] of [
  ["timeout", "throw", "timeout"], ["5xx", { status: 502, body: "bad gateway" }, "http_502"], ["401", { status: 401, body: "{}" }, "http_401"],
  ["malformed JSON", { status: 200, body: "not json" }, "malformed"], ["negative count", { status: 200, body: '{"in_flight":-1,"by_provider":{}}' }, "malformed"],
  ["missing count", { status: 200, body: '{"by_provider":{}}' }, "malformed"], ["fractional count", { status: 200, body: '{"in_flight":0.5,"by_provider":{}}' }, "malformed"],
] as const) test(`gate: ${name} is busy_unknown at once and the run touches nothing`, async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.inflight = () => resp as never; });
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "busy_unknown", gate: { verdict: "busy_unknown", reason } }); expect(w.mutations()).toEqual([]);
  expect(w.calls.filter(a => a[0] === "GET")).toHaveLength(1);
  rmSync(dir, { recursive: true });
});
test("gate: missing management key is busy_unknown without any HTTP call", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true);
  const out = await run(w.deps({ env: { CLIPROXY_ACCESS_KEY: ACCESS } }), target);
  expect(out).toMatchObject({ decision: "busy_unknown", gate: { reason: "mgmt_key_missing" } }); expect(w.calls.some(a => a[0] === "GET")).toBe(false); expect(w.mutations()).toEqual([]);
  rmSync(dir, { recursive: true });
});
test("gate: a hub that answers 404 falls back to dense OS sampling (>= 10 samples over >= 30 s)", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(false, w => { w.inflight = () => ({ status: 404, body: "404 page not found" }); });
  const start = w.clock; const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "would_upgrade_now", gate: { verdict: "idle", signal: "os_fallback" } });
  expect(w.calls.filter(a => a[0] === "nettop").length).toBeGreaterThanOrEqual(10); expect(w.clock - start).toBeGreaterThanOrEqual(29999); // 9 gaps of 30000/9 ms, float rounding
  rmSync(dir, { recursive: true });
});
test("gate: 404 fallback with changing counters is busy, unreadable OS signal is busy_unknown", async () => {
  const { run } = await runMod();
  const a = await setup(true, w => { w.inflight = () => ({ status: 404, body: "" }); let n = 0; const base = w.run; w.run = async (args, t, e) => args[0] === "nettop" ? `,bytes_in,bytes_out,\ncliproxyapi.100,1,2,\ntcp4 127.0.0.1:8317<->127.0.0.1:6000,${++n},5,\ntcp4 127.0.0.1:8317<->*:*,,,\n` : base(args, t, e); });
  expect((await run(a.w.deps(), a.target)).decision).toBe("busy"); expect(a.w.mutations()).toEqual([]);
  const b = await setup(true, w => { w.inflight = () => ({ status: 404, body: "" }); w.fail.add("nettop -p"); });
  expect((await run(b.w.deps(), b.target)).decision).toBe("busy_unknown"); expect(b.w.mutations()).toEqual([]);
  for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true });
});

// Criteria 4 and 5: success path, order of side effects, saved files.
test("success: exact order of side effects, saved config/plist/keg, new version running and probed", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true);
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ mode: "enabled", decision: "upgraded", installed: "8.0.64", available: "8.0.70", upgrade: { from: "8.0.64", to: "8.0.70" } });
  expect(w.running).toEqual({ pid: 101, version: "8.0.70" }); expect(w.linked).toBe("8.0.70");
  const effects = w.mutations().map(a => a.slice(0, 2).join(" "));
  expect(effects).toEqual(["ditto /C/cliproxyapi/8.0.64", "brew upgrade", "launchctl kickstart"]);
  expect(w.calls.find(a => a[1] === "upgrade")).toEqual(["brew", "upgrade", "--formula", "cliproxyapi"]);
  expect(w.calls.find(a => a[1] === "kickstart")).toEqual(["launchctl", "kickstart", "-k", "gui/501/sh.brew.cliproxyapi"]);
  const order = flat(w); const i = (s: string, from = 0) => order.indexOf(s, from);
  expect(i("brew update")).toBeLessThan(i("brew info")); expect(i("GET in-flight")).toBeLessThan(i("ditto"));
  expect(order.lastIndexOf("GET in-flight")).toBeGreaterThan(i("brew upgrade")); // recheck right before the restart
  expect(order.lastIndexOf("GET in-flight")).toBeLessThan(i("launchctl kickstart")); expect(order.lastIndexOf("probe")).toBeGreaterThan(i("launchctl kickstart"));
  expect(i("probe")).toBeLessThan(i("ditto")); // baseline probe of the running version before anything is saved
  const s = state(dir); expect(s.lastSuccessAt).toBe(new Date(w.clock).toISOString()); expect(s.journal).toBeUndefined();
  const backup = `${dir}/state/backups/${out.upgrade!.id}`;
  expect(readFileSync(backup + "/config", "utf8")).toBe("server:\n  port: 8317\n"); expect(readFileSync(backup + "/plist", "utf8")).toBe("<plist/>\n");
  for (const p of [dir + "/state", dir + "/state/backups", backup]) expect(statSync(p).mode & 0o777).toBe(0o700);
  for (const p of [backup + "/config", backup + "/plist", dir + "/state/state.json"]) expect(statSync(p).mode & 0o777).toBe(0o600);
  const probeEnv = w.envs.at(-1)!; expect(probeEnv).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_API_KEY: ACCESS, ANTHROPIC_AUTH_TOKEN: undefined });
  expect(JSON.stringify(out) + readFileSync(dir + "/state/state.json", "utf8")).not.toContain("PRIVATE");
  // A second run the same day refuses on the rate limit even if Homebrew moves again.
  w.stable = "8.0.71"; w.calls = []; expect((await run(w.deps(), target)).decision).toBe("rate_limited"); expect(w.mutations()).toEqual([]);
  rmSync(dir, { recursive: true });
});
test("brew upgrade runs with cleanup, auto-update and dependents check disabled", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true); const envs: Record<string, string | undefined>[] = [];
  const base = w.run; w.run = async (a, t, e) => { if (a[1] === "upgrade") envs.push(e ?? {}); return base(a, t, e); };
  await run(w.deps(), target);
  expect(envs[0]).toMatchObject({ HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1" });
  rmSync(dir, { recursive: true });
});

// Criterion 6: every failure point rolls back to the previous version, probed, consistent, recorded.
for (const [name, configure, reason] of [
  ["brew upgrade fails", (w: World) => { w.fail.add("brew upgrade"); }, "upgrade_failed"],
  ["upgrade leaves the wrong keg linked", (w: World) => { w.afterUpgrade = () => { w.linked = "8.0.64"; }; }, "link_mismatch"],
  ["config changed by the upgrade", (w: World) => { w.afterUpgrade = () => writeFileSync(w.dir + "/hub.conf", "changed\n"); }, "config_changed"],
  ["restart command fails", (w: World) => { w.afterUpgrade = () => w.fail.add("kickstart"); }, "restart_failed"],
  ["no new listener after restart", (w: World) => { w.afterUpgrade = () => w.fail.add("nostart"); }, "listener_timeout"],
  ["running process is not the new version", (w: World) => { w.afterUpgrade = () => w.fail.add("wrongexe"); }, "version_mismatch"],
  ["probe returns is_error", (w: World) => { w.probeBroken.add("8.0.70"); }, "probe_failed"],
  ["probe exits non-zero", (w: World) => { w.probeBroken.add("8.0.70"); w.fail.add("probe-exit"); }, "probe_failed"],
] as const) test(`failure rolls back and records the version: ${name}`, async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => (configure as (w: World) => void)(w));
  const base = w.run; w.run = async (a, t, e) => { if (a[0] === "launchctl" && a[1] === "kickstart" && w.linked === "8.0.64") { w.fail.delete("kickstart"); w.fail.delete("nostart"); w.fail.delete("wrongexe"); } return base(a, t, e); };
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rolled_back", reason, upgrade: { from: "8.0.64", to: "8.0.70" } });
  expect(w.linked).toBe("8.0.64"); expect([...w.kegs]).toEqual(["8.0.64"]); expect(w.running?.version).toBe("8.0.64");
  expect(flat(w).lastIndexOf("probe")).toBeGreaterThan(flat(w).lastIndexOf("brew link"));
  const s = state(dir); expect(s.failed["8.0.70"]).toMatchObject({ reason }); expect(s.journal).toBeUndefined();
  if (reason === "config_changed") expect(s.halted).toMatchObject({ reason: "config_changed" }); else expect(s.halted).toBeUndefined();
  expect(JSON.stringify(out) + JSON.stringify(s)).not.toContain("PRIVATE");
  // Never retried automatically.
  w.calls = []; w.fail.clear(); w.probeBroken.clear(); w.afterUpgrade = undefined; writeFileSync(dir + "/hub.conf", "server:\n  port: 8317\n");
  expect((await run(w.deps(), target)).decision).toBe(reason === "config_changed" ? "halted" : "version_failed"); expect(w.mutations()).toEqual([]);
  rmSync(dir, { recursive: true });
});
test("rollback restores the old keg from the saved copy when Homebrew removed it", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); w.afterUpgrade = () => w.kegs.delete("8.0.64"); });
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("rolled_back"); expect(w.linked).toBe("8.0.64"); expect([...w.kegs]).toEqual(["8.0.64"]);
  const dittos = w.calls.filter(a => a[0] === "ditto"); expect(dittos).toHaveLength(2);
  expect(dittos[1]).toEqual(["ditto", `${dir}/state/backups/${out.upgrade!.id}/keg`, "/C/cliproxyapi/8.0.64"]);
  rmSync(dir, { recursive: true });
});
test("a failed rollback is recorded as such and stops all further automatic runs", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); w.afterUpgrade = () => w.probeBroken.add("8.0.64"); }); // the old version passes its baseline, then breaks
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rollback_failed", reason: "probe_failed" });
  const s = state(dir); expect(s.halted).toMatchObject({ reason: "rollback_failed" }); expect(s.failed["8.0.70"]).toBeDefined();
  w.calls = []; w.probeBroken.clear(); expect((await run(w.deps(), target)).decision).toBe("halted"); expect(w.mutations()).toEqual([]);
  rmSync(dir, { recursive: true });
});
test("busy again right before the restart: the link is put back, no restart, version not marked failed", async () => {
  const { run } = await runMod(); let upgraded = false;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { upgraded = true; }; w.inflight = () => ({ status: 200, body: JSON.stringify({ in_flight: upgraded ? 1 : 0, by_provider: {} }) }); });
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "aborted_busy" }); expect(w.calls.some(a => a[1] === "kickstart")).toBe(false);
  expect(w.linked).toBe("8.0.64"); expect([...w.kegs]).toEqual(["8.0.64"]); expect(w.running).toEqual({ pid: 100, version: "8.0.64" });
  expect(state(dir).failed?.["8.0.70"]).toBeUndefined();
  rmSync(dir, { recursive: true });
});

// Criterion 7: interruption at every step.
for (const [step, hangOn] of [
  ["saving", (a: string[]) => a[0] === "ditto"], ["upgrading", (a: string[]) => a[1] === "upgrade"],
  ["rechecking", (a: string[]) => a[0] === "GET"], ["restarting", (a: string[]) => a[1] === "kickstart"],
  ["verifying", (a: string[]) => a[0] === "lsof" && a.includes("txt")], ["probing", (a: string[]) => a[0] === "probe"],
] as const) test(`killed while ${step}: the next run recovers without a second upgrade`, async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true);
  let armed = step === "rechecking" || step === "verifying" || step === "probing" ? false : true; // these commands also run earlier; arm after the upgrade
  w.afterUpgrade = () => { armed = true; };
  w.hang = a => armed && (hangOn as (a: string[]) => boolean)(a);
  void run(w.deps(), target);
  for (let i = 0; i < 200 && peek(dir).journal?.step !== step; i++) await Bun.sleep(1);
  expect(state(dir).journal.step).toBe(step);
  // Machine restarted: every child of the killed run is gone and launchd brings the hub back on the opt link.
  w.procs.clear(); if (step !== "saving" && step !== "rechecking") w.respawn();
  w.hang = undefined; w.calls = [];
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("recovered"); expect(w.calls.some(a => a[1] === "upgrade")).toBe(false);
  expect(w.linked).toBe("8.0.64"); expect([...w.kegs]).toEqual(["8.0.64"]); expect(w.running?.version).toBe("8.0.64");
  const s = state(dir); expect(s.journal).toBeUndefined();
  if (step === "saving") { expect(s.failed?.["8.0.70"]).toBeUndefined(); expect(w.mutations()).toEqual([]); }
  else { expect(s.failed["8.0.70"]).toMatchObject({ reason: `interrupted_at_${step}` }); expect(flat(w)).toContain("probe"); }
  rmSync(dir, { recursive: true });
});
test("an unfinished journal in dry-run mode is reported and nothing is touched", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(false);
  seed(dir, { journal: { id: "x", from: "8.0.64", to: "8.0.70", step: "probing", startedAt: "2026-11-15T07:00:00Z" } });
  expect((await run(w.deps(), target)).decision).toBe("interrupted_run_pending"); expect(w.mutations()).toEqual([]);
  rmSync(dir, { recursive: true });
});
test("a held run lock blocks a second run; once released the next run proceeds and the lock file stays", async () => {
  const { run, flockLock } = await runMod(); const { dir, w, target } = await setup(false);
  require("node:fs").mkdirSync(dir + "/state", { recursive: true, mode: 0o700 });
  const release = flockLock(dir + "/state/run.lock")!; expect(release).toBeDefined();
  expect((await run(w.deps({ lock: flockLock }), target)).decision).toBe("locked"); expect(w.calls).toEqual([]);
  release();
  expect((await run(w.deps({ lock: flockLock }), target)).decision).toBe("would_upgrade_now"); expect(existsSync(dir + "/state/run.lock")).toBe(true);
  rmSync(dir, { recursive: true });
});

test("probe result parsing: array or single object, result event must be success and not an error", async () => {
  const { probeOk } = await runMod();
  expect(probeOk(ok)).toBe(true); expect(probeOk(JSON.stringify([{ type: "system" }, JSON.parse(ok)]))).toBe(true);
  for (const bad of [broken, "", "[]", "{}", JSON.stringify([{ type: "system" }]), JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false }), JSON.stringify([JSON.parse(ok), JSON.parse(ok)])]) expect(probeOk(bad)).toBe(false);
});
test("target: hub defaults are the live facts; a target file overrides every hub-specific parameter", async () => {
  const { hubTarget, loadTarget } = await targetMod(); const t = hubTarget("/home/x");
  expect(t).toMatchObject({ formula: "cliproxyapi", label: "sh.brew.cliproxyapi", port: 8317, processName: "cliproxyapi", configPath: "/opt/homebrew/etc/cliproxyapi.conf",
    plistPath: "/home/x/Library/LaunchAgents/sh.brew.cliproxyapi.plist", hubUrl: "http://127.0.0.1:8317", confirmMs: 20000, pollMs: 2000, fallbackWindowS: 30, fallbackSamples: 10, minIntervalMs: 86400000 });
  expect(t.probe.slice(0, 4)).toEqual(["claude", "--bare", "--setting-sources", ""]); expect(t.probe).toContain("json");
  const dir = mkdtempSync(tmpdir() + "/hubtarget-");
  writeFileSync(dir + "/t.json", JSON.stringify({ formula: "standin", label: "dev.x.standin", port: 18517, processName: "standin", probe: ["curl", "-fsS", "http://127.0.0.1:18517/probe"] }));
  expect(loadTarget(dir + "/t.json", "/home/x")).toMatchObject({ formula: "standin", label: "dev.x.standin", port: 18517, hubUrl: "http://127.0.0.1:8317" });
  for (const bad of [{ formula: "../x" }, { port: "8317" }, { unknownKey: 1 }, { probe: [] }]) { writeFileSync(dir + "/b.json", JSON.stringify(bad)); expect(() => loadTarget(dir + "/b.json", "/home/x")).toThrow(); }
  rmSync(dir, { recursive: true });
});
test("CLI: run is wired, writes one final JSON line, and the launchd template schedules run every 30 minutes without enabling", async () => {
  const plist = readFileSync("launchd/com.tokenlayer.hubupdate.plist.template", "utf8");
  expect(plist).toContain("<string>run</string>"); expect(plist).toMatch(/<key>StartInterval<\/key><integer>1800<\/integer>/);
  expect(plist).not.toContain("StartCalendarInterval"); expect(plist).not.toMatch(/enabled|ENABLE/i);
  const bad = Bun.spawn(["/bin/sh", "bin/tokenlayer", "hubupdate", "run", "--bogus"], { stdout: "pipe", stderr: "pipe" });
  expect(await bad.exited).toBe(2); expect(JSON.parse(await new Response(bad.stdout).text()).decision).toBe("busy_unknown");
});
