// Fix round 1 for PR #170: each case is a guard for one review finding (Codex B1-B4, Opus F1-F6).
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { ACCESS, MGMT, World, flat, seed, setup, state, until } from "./world";
const runMod = () => import("../../src/hubupdate/run");
const ORIGINAL = "server:\n  port: 8317\n";
type Run = (a: string[], t?: number, e?: Record<string, string | undefined>, o?: (pid: number) => void) => Promise<string>;
/** Wrap the fake runner: `after` runs once the wrapped command has finished. */
const around = (w: World, after: (a: string[]) => void) => { const base: Run = w.run; w.run = async (a, t, e, o) => { const r = await base(a, t, e, o); after(a); return r; }; };
const busy = (n: number) => ({ status: 200, body: JSON.stringify({ in_flight: n, by_provider: n ? { claude: n } : {} }) });

// Fix 1 (Codex B2, Opus F1): config and plist really stay identical.
test("B2/F1: rollback writes the saved config and plist back, with their modes, before the old version is probed", async () => {
  const { run } = await runMod(); const seen: string[] = [];
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { writeFileSync(w.dir + "/hub.conf", "changed\n"); chmodSync(w.dir + "/hub.conf", 0o600); writeFileSync(w.dir + "/hub.plist", "<other/>\n"); }; });
  chmodSync(dir + "/hub.conf", 0o640); chmodSync(dir + "/hub.plist", 0o644);
  w.onProbe = () => seen.push(readFileSync(dir + "/hub.conf", "utf8"));
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rolled_back", reason: "config_changed" });
  expect(readFileSync(dir + "/hub.conf", "utf8")).toBe(ORIGINAL); expect(readFileSync(dir + "/hub.plist", "utf8")).toBe("<plist/>\n");
  expect(statSync(dir + "/hub.conf").mode & 0o7777).toBe(0o640); expect(statSync(dir + "/hub.plist").mode & 0o7777).toBe(0o644);
  expect(seen.at(-1)).toBe(ORIGINAL); // the old version's probe ran on the restored config
  expect(state(dir)).toMatchObject({ halted: { reason: "config_changed" }, failed: { "8.0.70": { reason: "config_changed" } } });
  rmSync(dir, { recursive: true });
});
test("F1: a new version that rewrites its config on start is rolled back even when its probe passes, and a person is asked", async () => {
  const { run } = await runMod(); const seen: string[] = [];
  const { dir, w, target } = await setup(true);
  around(w, a => { if (a[1] === "kickstart" && w.running?.version === "8.0.70") writeFileSync(dir + "/hub.conf", "rewritten by 8.0.70\n"); });
  w.onProbe = () => seen.push(`${w.running?.version}:${readFileSync(dir + "/hub.conf", "utf8")}`);
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rolled_back", reason: "config_changed" });
  expect(w.running?.version).toBe("8.0.64"); expect(w.linked).toBe("8.0.64"); expect(readFileSync(dir + "/hub.conf", "utf8")).toBe(ORIGINAL);
  expect(seen.at(-1)).toBe("8.0.64:" + ORIGINAL);
  expect(state(dir)).toMatchObject({ halted: { reason: "config_changed" }, failed: { "8.0.70": { reason: "config_changed", step: "probing" } } });
  expect(state(dir).lastSuccessAt).toBeUndefined();
  rmSync(dir, { recursive: true });
});
test("F1: a config rewritten on start with a failing probe is restored before the old version runs", async () => {
  const { run } = await runMod(); const seen: string[] = [];
  const { dir, w, target } = await setup(true, w => w.probeBroken.add("8.0.70"));
  around(w, a => { if (a[1] === "kickstart" && w.running?.version === "8.0.70") writeFileSync(dir + "/hub.conf", "rewritten by 8.0.70\n"); });
  w.onProbe = () => seen.push(`${w.running?.version}:${readFileSync(dir + "/hub.conf", "utf8")}`);
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rolled_back", reason: "probe_failed" });
  expect(readFileSync(dir + "/hub.conf", "utf8")).toBe(ORIGINAL); expect(seen.at(-1)).toBe("8.0.64:" + ORIGINAL);
  rmSync(dir, { recursive: true });
});

// Fix 3 (Codex B3, Opus F2): a busy hub is never restarted by rollback or recovery.
for (const [name, second] of [["busy", busy(1)], ["unreadable", "throw"]] as const)
  test(`B3: launchd restarted the new version inside the upgrade window, second gate ${name}: verify and probe it, no kickstart`, async () => {
    const { run } = await runMod(); let upgraded = false;
    const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { upgraded = true; w.respawn(); }; w.inflight = () => upgraded ? second : busy(0); });
    const out = await run(w.deps(), target);
    expect(w.calls.some(a => a[1] === "kickstart")).toBe(false);
    expect(out).toMatchObject({ decision: "upgraded" }); expect(w.running?.version).toBe("8.0.70");
    rmSync(dir, { recursive: true });
  });
test("F2: recovery never restarts a busy hub; it keeps the journal, reports rollback_pending, and finishes once idle", async () => {
  const { run } = await runMod(); let armed = false, load = 0;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { armed = true; }; w.hang = a => armed && a[0] === "probe"; w.inflight = () => busy(load); });
  void run(w.deps(), target); await until(dir, "probing");
  w.procs.clear(); w.respawn(); w.hang = undefined; w.calls = []; load = 2; // rebooted onto 8.0.70, which is now serving
  const pending = await run(w.deps(), target);
  expect(pending).toMatchObject({ decision: "rollback_pending", reason: "interrupted_at_probing" });
  expect(w.calls.some(a => a[1] === "kickstart")).toBe(false); expect(w.running?.version).toBe("8.0.70");
  expect(state(dir).journal).toMatchObject({ step: "rolling_back", to: "8.0.70" });
  load = 0; w.calls = [];
  const done = await run(w.deps(), target);
  expect(done).toMatchObject({ decision: "recovered" }); expect(w.running?.version).toBe("8.0.64"); expect(w.linked).toBe("8.0.64");
  expect(state(dir).journal).toBeUndefined(); expect(state(dir).failed["8.0.70"]).toMatchObject({ reason: "interrupted_at_probing" });
  rmSync(dir, { recursive: true });
});
test("F2: a rollback after a failed probe waits for idle before restarting, keeping the original reason", async () => {
  const { run } = await runMod(); let load = 0;
  const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); w.inflight = () => busy(load); });
  around(w, a => { if (a[1] === "kickstart" && w.running?.version === "8.0.70") load = 3; });
  expect(await run(w.deps(), target)).toMatchObject({ decision: "rollback_pending", reason: "probe_failed" });
  expect(w.calls.filter(a => a[1] === "kickstart")).toHaveLength(1); expect(w.running?.version).toBe("8.0.70");
  load = 0;
  expect(await run(w.deps(), target)).toMatchObject({ decision: "recovered", reason: "probe_failed" });
  expect(w.running?.version).toBe("8.0.64"); expect(state(dir).failed["8.0.70"]).toMatchObject({ reason: "probe_failed", step: "probing" });
  rmSync(dir, { recursive: true });
});
test("control: with no listener at all, recovery restarts without polling the in-flight route", async () => {
  const { run } = await runMod(); let armed = false;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { armed = true; }; w.hang = a => armed && a[0] === "lsof" && a.includes("txt"); });
  void run(w.deps(), target); await until(dir, "verifying");
  w.procs.clear(); w.running = null; w.hang = undefined; w.calls = [];
  expect((await run(w.deps(), target)).decision).toBe("recovered");
  expect(w.calls.some(a => a[0] === "GET")).toBe(false); expect((w.running as World["running"])?.version).toBe("8.0.64");
  rmSync(dir, { recursive: true });
});

// Fix 2 (Codex B1): no recovery while a command of the dead run may still be running.
test("B1: a brew upgrade that outlived its killed run blocks recovery until it exits", async () => {
  const { run } = await runMod(); let armed = false;
  const { dir, w, target } = await setup(true, w => { w.hang = a => a[1] === "upgrade"; w.afterUpgrade = () => { armed = true; }; });
  void run(w.deps(), target); await until(dir, "upgrading");
  expect(state(dir).journal.child).toMatchObject({ cmd: "brew_upgrade" });
  w.hang = undefined; w.calls = [];
  const blocked = await run(w.deps(), target);
  expect(blocked).toMatchObject({ decision: "command_still_running", reason: "brew_upgrade" });
  expect(w.mutations()).toEqual([]); expect(state(dir).journal.step).toBe("upgrading");
  w.procs.clear(); w.calls = []; void armed;
  expect((await run(w.deps(), target)).decision).toBe("recovered"); expect(w.linked).toBe("8.0.64");
  rmSync(dir, { recursive: true });
});
test("B1: an orphan still alive after the bound halts for a person", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.hang = a => a[0] === "ditto"; });
  void run(w.deps(), target); await until(dir, "saving");
  w.hang = undefined; w.clock += target.orphanHaltMs + 1; w.calls = [];
  expect(await run(w.deps(), target)).toMatchObject({ decision: "halted", reason: "orphan_command" });
  expect(w.mutations()).toEqual([]); expect(state(dir).halted).toMatchObject({ reason: "orphan_command" });
  rmSync(dir, { recursive: true });
});
test("B1: Homebrew's own formula lock blocks recovery and blocks a new upgrade", async () => {
  const { run } = await runMod();
  const a = await setup(true); seed(a.dir, { journal: { id: "x", from: "8.0.64", to: "8.0.70", step: "upgrading", startedAt: "2026-11-15T07:59:00.000Z", updatedAt: "2026-11-15T07:59:00.000Z" } });
  a.w.brewLock = true;
  expect(await run(a.w.deps(), a.target)).toMatchObject({ decision: "command_still_running", reason: "brew_lock_held" }); expect(a.w.mutations()).toEqual([]);
  expect(a.w.calls.find(c => c[0] === "lsof" && c[1] === "-t")).toEqual(["lsof", "-t", "/var/homebrew/locks/cliproxyapi.formula.lock"]);
  const b = await setup(true, w => { w.brewLock = true; });
  expect((await run(b.w.deps(), b.target)).decision).toBe("brew_busy"); expect(b.w.mutations()).toEqual([]);
  for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true });
});
test("control: a recorded child PID that now belongs to another process does not block recovery", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.hang = a => a[1] === "upgrade"; });
  void run(w.deps(), target); await until(dir, "upgrading");
  for (const pid of w.procs.keys()) w.procs.set(pid, "Mon Nov 16 01:02:03 2026"); // same PID, different start time
  w.hang = undefined; w.calls = [];
  expect((await run(w.deps(), target)).decision).toBe("recovered");
  rmSync(dir, { recursive: true });
});

// Opus F5 / mutation M4: a run killed while rolling back resumes with the same intent.
test("F5: killed while rolling back a busy abort: the resumed rollback still does not mark the version failed", async () => {
  const { run } = await runMod(); let upgraded = false;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { upgraded = true; }; w.inflight = () => busy(upgraded ? 1 : 0); w.hang = a => upgraded && a[0] === "probe"; });
  void run(w.deps(), target); await until(dir, "rolling_back");
  for (let i = 0; i < 200 && !w.calls.some(a => a[0] === "probe" && upgraded); i++) await Bun.sleep(1);
  w.procs.clear(); w.hang = undefined; w.calls = [];
  expect((await run(w.deps(), target)).decision).toBe("recovered");
  expect(state(dir).failed?.["8.0.70"]).toBeUndefined(); expect(w.linked).toBe("8.0.64");
  rmSync(dir, { recursive: true });
});
test("F5: killed while rolling back a config change: the resumed rollback keeps the reason and the halt", async () => {
  const { run } = await runMod(); let upgraded = false;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { upgraded = true; writeFileSync(w.dir + "/hub.conf", "changed\n"); }; w.hang = a => upgraded && a[0] === "probe"; });
  void run(w.deps(), target); await until(dir, "rolling_back");
  for (let i = 0; i < 200 && !w.calls.some(a => a[0] === "probe" && upgraded); i++) await Bun.sleep(1);
  w.procs.clear(); w.hang = undefined; w.calls = [];
  await run(w.deps(), target);
  expect(state(dir)).toMatchObject({ halted: { reason: "config_changed" }, failed: { "8.0.70": { reason: "config_changed" } } });
  rmSync(dir, { recursive: true });
});

// Fix 5 (Opus F3): a rollback can never leave nothing linked.
test("F3: brew link of the old keg fails: the new keg is put back and linked, nothing is destroyed, halted", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); w.fail.add("link-once"); });
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rollback_failed", reason: "probe_failed" });
  expect([...w.kegs].sort()).toEqual(["8.0.64", "8.0.70"]); expect(w.linked).toBe("8.0.70"); expect(w.opt).toBe("8.0.70");
  expect(w.calls.some(a => a[0] === "rm")).toBe(false); expect(state(dir).halted).toMatchObject({ reason: "rollback_failed" });
  rmSync(dir, { recursive: true });
});

// Fix 4 (Codex B4, Opus F10): one run at a time.
test("B4: two runs started together: exactly one gets the lock", async () => {
  const { run, flockLock } = await runMod(); const { dir, w, target } = await setup(false);
  const results = await Promise.all([run(w.deps({ lock: flockLock }), target), run(w.deps({ lock: flockLock }), target)]);
  expect(results.map(r => r.decision).sort()).toEqual(["locked", "would_upgrade_now"]);
  rmSync(dir, { recursive: true });
});
test("B4: a lock file naming a live but unrelated PID (reused) does not block; an unreadable one is not deleted", async () => {
  const { run, flockLock } = await runMod(); const { dir, w, target } = await setup(false);
  mkdirSync(dir + "/state", { recursive: true, mode: 0o700 }); writeFileSync(dir + "/state/run.lock", JSON.stringify({ pid: process.pid }));
  expect((await run(w.deps({ lock: flockLock, alive: () => true }), target)).decision).toBe("would_upgrade_now");
  writeFileSync(dir + "/state/run.lock", "\0garbage");
  expect((await run(w.deps({ lock: flockLock, alive: () => true }), target)).decision).toBe("would_upgrade_now"); expect(existsSync(dir + "/state/run.lock")).toBe(true);
  rmSync(dir, { recursive: true });
});
test("control: a stale lock file from a dead run is taken over", async () => {
  const { run, flockLock } = await runMod(); const { dir, w, target } = await setup(false);
  mkdirSync(dir + "/state", { recursive: true, mode: 0o700 }); writeFileSync(dir + "/state/run.lock", JSON.stringify({ pid: 999999 }));
  expect((await run(w.deps({ lock: flockLock, alive: () => false }), target)).decision).toBe("would_upgrade_now");
  rmSync(dir, { recursive: true });
});

// Fix 6 (Opus F6): probe the running version before upgrading.
test("F6: a failing probe on the current version blocks the upgrade and marks nothing failed", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => w.probeBroken.add("8.0.64"));
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "probe_baseline_failed" }); expect(w.mutations()).toEqual([]);
  expect(state(dir).failed?.["8.0.70"]).toBeUndefined(); expect(state(dir).halted).toBeUndefined();
  rmSync(dir, { recursive: true });
});

// Fix 7 (Opus F4): clear a failed version or a halt from the CLI, logged.
test("F4: clear removes one failed version or the halt, and logs who cleared what", async () => {
  const { clear } = await runMod(); const { dir, w, target } = await setup(true); const lines: string[] = [];
  seed(dir, { failed: { "8.0.70": { at: "x", reason: "probe_failed", step: "probing" }, "8.0.71": { at: "x", reason: "y", step: "z" } }, halted: { at: "x", reason: "rollback_failed" } });
  expect(await clear(w.deps({ log: (l: string) => lines.push(l) }), target, { failed: "8.0.70" })).toMatchObject({ decision: "cleared" });
  expect(Object.keys(state(dir).failed)).toEqual(["8.0.71"]); expect(state(dir).halted).toBeDefined();
  await clear(w.deps({ log: (l: string) => lines.push(l) }), target, { halt: true });
  expect(state(dir).halted).toBeUndefined();
  expect(state(dir).cleared.map((c: { what: string }) => c.what)).toEqual(["failed:8.0.70", "halt:rollback_failed"]);
  expect(lines.join("\n")).toContain("failed:8.0.70");
  expect((await clear(w.deps(), target, { failed: "9.9.9" })).decision).toBe("nothing_to_clear");
  rmSync(dir, { recursive: true });
});
test("F4: CLI clear validates its arguments and clears through a target file", async () => {
  for (const args of [["clear"], ["clear", "--failed"], ["clear", "--failed", "../x"], ["clear", "--bogus"]]) {
    const p = Bun.spawn(["/bin/sh", "bin/tokenlayer", "hubupdate", ...args], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2); expect(JSON.parse(await new Response(p.stdout).text()).reason).toContain("usage");
  }
  const { dir } = await setup(false); seed(dir, { failed: { "8.0.70": { at: "x", reason: "probe_failed", step: "probing" } } });
  writeFileSync(dir + "/target.json", JSON.stringify({ stateDir: dir + "/state" }));
  const p = Bun.spawn(["/bin/sh", "bin/tokenlayer", "hubupdate", "clear", "--failed", "8.0.70", "--target", dir + "/target.json"], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(0); const lines = (await new Response(p.stdout).text()).trim().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ decision: "cleared", what: "failed:8.0.70" }); expect(state(dir).failed).toEqual({});
  rmSync(dir, { recursive: true });
});
void ACCESS; void MGMT; void flat;
