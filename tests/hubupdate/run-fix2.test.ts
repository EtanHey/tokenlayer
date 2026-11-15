// Fix round 1b for PR #170: a pending rollback is forced once it has waited its limit (lead decision, 2026-11-15).
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { seed, setup, state, World } from "./world";
const runMod = () => import("../../src/hubupdate/run");
const SHORT = 30 * 60_000, LONG = 6 * 3_600_000;
const busy = { status: 200, body: JSON.stringify({ in_flight: 2, by_provider: { claude: 2 } }) };

/** A rollback left pending by an earlier run: 8.0.70 linked and serving, `pendingSince` = now - `waited`. */
async function pending(reason: string, waited: number, gate: "throw" | typeof busy) {
  const s = await setup(true, w => {
    w.kegs = new Set(["8.0.64", "8.0.70"]); w.linked = w.opt = "8.0.70"; w.running = { pid: 101, version: "8.0.70" }; w.inflight = () => gate;
  });
  const file = (p: string) => ({ sha: createHash("sha256").update(readFileSync(p)).digest("hex"), mode: statSync(p).mode & 0o7777 });
  const config = file(s.dir + "/hub.conf"), plist = file(s.dir + "/hub.plist"), at = new Date(s.w.clock).toISOString();
  seed(s.dir, { journal: { id: "j1", from: "8.0.64", to: "8.0.70", step: "rolling_back", startedAt: at, updatedAt: at, kegsBefore: ["8.0.64"],
    configSha: config.sha, configMode: config.mode, plistSha: plist.sha, plistMode: plist.mode,
    reason, failedStep: "probing", markFailed: true, pendingSince: new Date(s.w.clock - waited).toISOString() } });
  return s;
}
const restarted = (w: World) => w.calls.some(a => a[1] === "kickstart");

// The hub fails real requests: short limit.
for (const reason of ["probe_failed", "version_mismatch", "listener_timeout"]) {
  test(`${reason}: unreadable gate one second before 30 min stays pending`, async () => {
    const { run } = await runMod(); const { dir, w, target } = await pending(reason, SHORT - 1000, "throw");
    expect(await run(w.deps(), target)).toMatchObject({ decision: "rollback_pending" });
    expect(restarted(w)).toBe(false); expect(w.running?.version).toBe("8.0.70"); expect(state(dir).journal.step).toBe("rolling_back");
    rmSync(dir, { recursive: true });
  });
  test(`${reason}: unreadable gate at 30 min forces the restart to the old version, loudly`, async () => {
    const { run } = await runMod(); const { dir, w, target } = await pending(reason, SHORT, "throw"); const lines: string[] = [];
    const out = await run(w.deps({ log: (l: string) => lines.push(l) }), target);
    expect(out).toMatchObject({ decision: "recovered", reason, forced: { reason, waitedMs: SHORT, limitMs: SHORT, gate: "timeout" } });
    expect(restarted(w)).toBe(true); expect(w.running?.version).toBe("8.0.64"); expect(w.linked).toBe("8.0.64");
    const event = lines.map(l => JSON.parse(l)).find(e => e.event === "forced_rollback");
    expect(event).toMatchObject({ reason, waitedMs: SHORT, limitMs: SHORT });
    expect(state(dir).journal).toBeUndefined(); expect(state(dir).failed["8.0.70"]).toMatchObject({ reason });
    rmSync(dir, { recursive: true });
  });
}

// The new version may be healthy: long limit.
for (const reason of ["config_changed", "interrupted_at_probing"]) {
  test(`${reason}: still pending at 30 min and one second before 6 h`, async () => {
    const { run } = await runMod();
    for (const waited of [SHORT, LONG - 1000]) {
      const { dir, w, target } = await pending(reason, waited, "throw");
      expect((await run(w.deps(), target)).decision).toBe("rollback_pending"); expect(restarted(w)).toBe(false);
      rmSync(dir, { recursive: true });
    }
  });
  test(`${reason}: forced at 6 h`, async () => {
    const { run } = await runMod(); const { dir, w, target } = await pending(reason, LONG, "throw");
    const out = await run(w.deps(), target);
    expect(out).toMatchObject({ decision: "recovered", forced: { reason, waitedMs: LONG, limitMs: LONG } });
    expect(restarted(w)).toBe(true); expect(w.running?.version).toBe("8.0.64");
    rmSync(dir, { recursive: true });
  });
}

test("a busy gate counts like an unreadable one, and the time spent waiting in it counts toward the limit", async () => {
  const { run } = await runMod();
  const a = await pending("probe_failed", 10 * 60_000, busy);
  expect((await run(a.w.deps(), a.target)).decision).toBe("rollback_pending"); expect(restarted(a.w)).toBe(false);
  // One second short when the run starts; the 4-minute busy gate carries it past the limit.
  const b = await pending("probe_failed", SHORT - 1000, busy);
  const out = await run(b.w.deps(), b.target);
  expect(out).toMatchObject({ decision: "recovered", forced: { reason: "probe_failed", limitMs: SHORT, gate: "in_flight_nonzero" } });
  expect(out.forced!.waitedMs).toBeGreaterThanOrEqual(SHORT); expect(restarted(b.w)).toBe(true);
  for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true });
});

test("forced restarts still run the rest of the rollback: a failing old-version probe halts", async () => {
  const { run } = await runMod(); const { dir, w, target } = await pending("probe_failed", SHORT, "throw");
  w.probeBroken.add("8.0.64");
  expect(await run(w.deps(), target)).toMatchObject({ decision: "rollback_failed", forced: { reason: "probe_failed" } });
  expect(state(dir).halted).toMatchObject({ reason: "rollback_failed" });
  rmSync(dir, { recursive: true });
});

test("both limits are target parameters with the decided defaults", async () => {
  const { hubTarget, loadTarget } = await import("../../src/hubupdate/target");
  expect(hubTarget("/home/x")).toMatchObject({ rollbackForceUnhealthyMs: SHORT, rollbackForceMs: LONG });
  const { run } = await runMod(); const { dir, w, target } = await pending("config_changed", 61_000, "throw");
  const out = await run(w.deps(), { ...target, rollbackForceMs: 60_000 });
  expect(out).toMatchObject({ decision: "recovered", forced: { limitMs: 60_000 } });
  rmSync(dir, { recursive: true });
  void loadTarget;
});
