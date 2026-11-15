// Fix round 2 for PR #170: a failed or ambiguous observation is never read as a definite answer.
// The first three cases are reviewer w7's (w7-new-adverse.ts.txt), kept as written in substance.
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { setup, state, until, World } from "./world";
const runMod = () => import("../../src/hubupdate/run");
type Run = World["run"];
const step = (dir: string) => { try { return state(dir).journal?.step as string | undefined; } catch { return undefined; } };
/** Replace the fake runner: `fault` may throw or return a string; `undefined` falls through to the real fake. */
const inject = (w: World, fault: (a: string[]) => string | undefined) => { const base: Run = w.run; w.run = async (a, t, e, o) => { const r = fault(a); return r === undefined ? base(a, t, e, o) : r; }; };
const busyWhileNew = (w: World) => { w.inflight = () => ({ status: 200, body: JSON.stringify({ in_flight: w.running?.version === "8.0.70" ? 3 : 0, by_provider: {} }) }); };
const kickstarts = (w: World) => w.calls.filter(a => a[1] === "kickstart").length;
const isListen = (a: string[]) => a[0] === "lsof" && a.includes("-sTCP:LISTEN");
const isExe = (a: string[]) => a[0] === "lsof" && a.includes("txt");

// R2-3: a live PID whose start time cannot be read is not proof the command is gone.
test("W7: an alive child with an unreadable start time fences recovery", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.hang = a => a[0] === "ditto"; });
  void run(w.deps(), target); await until(dir, "saving"); w.hang = undefined; w.calls = [];
  inject(w, a => { if (a[0] === "ps" && a.includes("lstart=")) throw Error("ps timeout"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("command_still_running"); expect(w.mutations()).toEqual([]); expect(state(dir).journal.step).toBe("saving");
  rmSync(dir, { recursive: true, force: true });
});

// R2-2: the whole relink transition is compensated, including a move that fails half-way.
test("W7: a second move-aside failure leaves opt on a keg that exists, nothing lost", async () => {
  const { run } = await runMod(); let moves = 0;
  const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); w.afterUpgrade = () => w.kegs.add("8.0.69"); });
  inject(w, a => { if (a[0] === "mv" && a[1].startsWith("/C/") && ++moves === 2) throw Error("mv failed"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("rollback_failed"); expect(w.kegs.has(w.opt!)).toBe(true);
  expect([...w.kegs].sort()).toEqual(["8.0.64", "8.0.69", "8.0.70"]);
  expect(state(dir).halted).toMatchObject({ reason: "rollback_failed", opt: { version: w.opt, runnable: true } });
  rmSync(dir, { recursive: true, force: true });
});

// R2-1: an unreadable listener is not "nothing listening".
test("W7: an unreadable listener during a busy rollback follows the pending path, no second restart", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); busyWhileNew(w); });
  inject(w, a => { if (isListen(a) && step(dir) === "rolling_back") throw Error("lsof timeout"); return undefined; });
  const out = await run(w.deps(), target);
  expect(kickstarts(w)).toBe(1); expect(out.decision).toBe("rollback_pending"); expect(w.running?.version).toBe("8.0.70");
  rmSync(dir, { recursive: true, force: true });
});
test("audit: several listener PIDs during a busy rollback are unknown, not absent", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); busyWhileNew(w); });
  inject(w, a => isListen(a) && step(dir) === "rolling_back" ? "p101\nf13\np202\nf13\n" : undefined);
  expect((await run(w.deps(), target)).decision).toBe("rollback_pending"); expect(kickstarts(w)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});
test("audit: an unreadable executable during a busy rollback is unknown: pending, not a halt", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); busyWhileNew(w); });
  inject(w, a => { if (isExe(a) && step(dir) === "rolling_back") throw Error("lsof timeout"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("rollback_pending"); expect(state(dir).halted).toBeUndefined(); expect(kickstarts(w)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});
test("audit: an unreadable Cellar during recovery cannot clear the Homebrew lock: still running, nothing changed", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.hang = a => a[1] === "upgrade"; });
  void run(w.deps(), target); await until(dir, "upgrading"); w.procs.clear(); w.hang = undefined; w.calls = [];
  inject(w, a => { if (a[0] === "brew" && a[1] === "--cellar") throw Error("brew timeout"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "command_still_running", reason: "brew_lock_unknown" }); expect(w.mutations()).toEqual([]);
  expect(state(dir).halted).toBeUndefined(); expect(state(dir).journal.step).toBe("upgrading");
  rmSync(dir, { recursive: true, force: true });
});
test("audit: an unreadable listener at the recheck is not a launchd self-restart: gate, then our own restart", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true);
  inject(w, a => { if (isListen(a) && step(dir) === "rechecking") throw Error("lsof timeout"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("upgraded"); expect(kickstarts(w)).toBe(1); expect(w.running?.version).toBe("8.0.70");
  rmSync(dir, { recursive: true, force: true });
});
test("audit: an unreadable executable at verify is its own reason (short-limit class), not a version mismatch", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true);
  inject(w, a => { if (isExe(a) && step(dir) === "verifying") throw Error("lsof timeout"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rolled_back", reason: "version_unreadable" }); expect(w.running?.version).toBe("8.0.64");
  rmSync(dir, { recursive: true, force: true });
});
test("audit: if put-back cannot move the new keg home, opt is repaired onto a keg that exists before halting", async () => {
  const { run } = await runMod(); let moves = 0, links = 0;
  const { dir, w, target } = await setup(true, w => w.probeBroken.add("8.0.70"));
  // Linking 8.0.64 fails, moving 8.0.70 home fails, relinking fails: opt is left on the moved 8.0.70.
  inject(w, a => { if (a[0] === "mv" && ++moves >= 2) throw Error("mv back failed"); if (a[0] === "brew" && a[1] === "link" && ++links <= 2) throw Error("link failed"); return undefined; });
  const out = await run(w.deps(), target);
  expect(out.decision).toBe("rollback_failed"); expect(w.kegs.has(w.opt!)).toBe(true); expect(w.opt).toBe("8.0.64");
  expect(state(dir).halted).toMatchObject({ reason: "rollback_failed", opt: { version: "8.0.64", runnable: true, repaired: true } });
  rmSync(dir, { recursive: true, force: true });
});
test("the TCP probe tells verified absence (refused) from something listening", async () => {
  const { tcpConnect } = await runMod();
  const server = createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  expect(await tcpConnect(port)).toBe("open");
  await new Promise<void>(r => server.close(() => r()));
  expect(await tcpConnect(port)).toBe("refused");
});
