import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { flat, peek, setup, state, until, type World } from "./world";
const runMod = () => import("../../src/hubupdate/run");
const probeMod = () => import("../../src/hubupdate/probe");

// Slice C: a slow Homebrew must not look like a bad upgrade. Measured 2026-11-15/16 on the hub Mac: `brew info` hit
// its 15 s limit in 6 of 39 runs (normally 0.5 s). The logged line of such a run (hubupdate.log line 18) was:
// {"mode":"dry_run","decision":"busy_unknown","refresh":"ok","versionError":{"step":"brew_info","kind":"timed_out"},
//  "installed":null,"available":null,"reason":"version_unreadable","failedVersions":[]}

const isRead = (a: string[]) => a[0] === "brew" && (a[1] === "info" || a[1] === "--cellar");
/**
 * Times out read number `n` (1-based, counted while `armed()`) and then each immediate repeat of that same command,
 * up to `times` timeouts in all; any other command ends the streak. Every other call is normal.
 * `fired` counts the injected timeouts, so a test can prove its injection point exists.
 */
function slowRead(n: number, times: number, armed: () => boolean = () => true) {
  let seen = 0, left = times, streak = false, last = "";
  const s = { fired: 0, slow: (a: string[]) => {
    const key = a.join(" "), prev = last; last = key;
    if (streak) {
      if (key === prev) { if (left > 0) { left--; s.fired++; return true; } streak = false; return false; } // a repeat of read n
      streak = false; left = 0;
    }
    if (!isRead(a) || !armed()) return false;
    if (++seen === n && left > 0) { left--; s.fired++; streak = true; return true; }
    return false;
  } };
  return s;
}
type Outcome = { decision: string; reason?: string; failed: string[]; halted?: string; linked: string | null; kegs: string[]; running?: string };
const outcome = (out: { decision: string; reason?: string }, dir: string, w: World): Outcome => {
  const s = peek(dir);
  return { decision: out.decision, reason: out.reason, failed: Object.keys(s.failed ?? {}), halted: s.halted?.reason, linked: w.linked, kegs: [...w.kegs].sort(), running: w.running?.version };
};
const limitsOf = (w: World, sub: string) => w.calls.flatMap((a, i) => (a[0] === "brew" && a[1] === sub ? [w.limits[i]] : []));

// ---- Pass criterion 1: read-only queries get three tries (15 s, 45 s, 90 s) on timeout, and only on timeout.

for (const [site, n] of [["brew info at the decision", 1], ["brew --cellar at the decision", 2]] as const)
  for (const times of [1, 2]) test(`dry run: ${times} timeout(s) of ${site} give the same decision as none`, async () => {
    const { run } = await runMod();
    const base = await setup(false); const want = outcome(await run(base.w.deps(), base.target), base.dir, base.w);
    expect(want.decision).toBe("would_upgrade_now");
    const { dir, w, target } = await setup(false); const s = slowRead(n, times); w.slow = s.slow;
    const out = await run(w.deps(), target);
    expect(s.fired).toBe(times); expect(outcome(out, dir, w)).toEqual(want); expect(w.mutations()).toEqual([]);
    const sub = n === 1 ? "info" : "--cellar";
    expect(limitsOf(w, sub)).toEqual([15_000, 45_000, 90_000].slice(0, times + 1));
    expect((out as { timings?: unknown }).timings).toContainEqual({ step: `brew_${sub}`, ms: [0, 15_000, 60_000][times], tries: times + 1 });
    expect(JSON.stringify(out) + JSON.stringify(state(dir))).not.toContain("PRIVATE");
    for (const d of [base.dir, dir]) rmSync(d, { recursive: true });
  });

test("three timeouts in a row at the decision read end as today: version_unreadable, the logged shape", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(false); w.slow = a => a[0] === "brew" && a[1] === "info";
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ mode: "dry_run", decision: "busy_unknown", refresh: "ok", versionError: { step: "brew_info", kind: "timed_out" }, installed: null, available: null, reason: "version_unreadable", failedVersions: [] });
  expect(limitsOf(w, "info")).toEqual([15_000, 45_000, 90_000]); // a fourth try is never made
  expect((out as { timings?: unknown }).timings).toContainEqual({ step: "brew_info", ms: 150_000, tries: 3 });
  rmSync(dir, { recursive: true });
});
test("a nonzero exit or unparsable output of a read is not tried again", async () => {
  const { run } = await runMod();
  const a = await setup(false); a.w.fail.add("brew info");
  expect(await run(a.w.deps(), a.target)).toMatchObject({ decision: "busy_unknown", reason: "version_unreadable", versionError: { step: "brew_info", kind: "nonzero" } });
  expect(limitsOf(a.w, "info")).toHaveLength(1);
  const b = await setup(false); b.w.info = () => "not json";
  expect(await run(b.w.deps(), b.target)).toMatchObject({ decision: "busy_unknown", reason: "version_unreadable" });
  expect(limitsOf(b.w, "info")).toHaveLength(1);
  for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true });
});
test("the read helper: only timed_out is retried, with the given limits, and one timing entry per call", async () => {
  const { retried, READ_LIMITS } = await probeMod() as unknown as { retried: Function; READ_LIMITS: number[] };
  expect(READ_LIMITS).toEqual([15_000, 45_000, 90_000]);
  let clock = 0; const seen: (number | undefined)[] = [];
  const answers: (string | { code?: string })[] = [{ code: "ETIMEDOUT" }, { code: "ETIMEDOUT" }, "ok"];
  const run = async (_a: string[], t?: number) => { seen.push(t); clock += 7; const r = answers.shift()!; if (typeof r !== "string") throw Object.assign(Error("x"), r); return r; };
  const timings: unknown[] = [];
  expect(await retried(run, ["brew", "info", "--json=v2", "x"], READ_LIMITS, undefined, () => clock, timings)).toBe("ok");
  expect(seen).toEqual([15_000, 45_000, 90_000]); expect(timings).toEqual([{ step: "brew_info", ms: 21, tries: 3 }]);
  answers.push({ status: 1 } as never, "ok"); seen.length = 0;
  await expect(retried(run, ["brew", "--cellar", "x"], READ_LIMITS, undefined, () => clock, timings)).rejects.toMatchObject({ step: "brew_--cellar", kind: "nonzero" });
  expect(seen).toEqual([15_000]); expect(timings.at(-1)).toMatchObject({ step: "brew_--cellar", tries: 1 });
});
test("check: one timed-out brew info still reads the versions", async () => {
  const { check } = await probeMod(); let n = 0;
  const info = JSON.stringify({ formulae: [{ name: "cliproxyapi", linked_keg: "8.0.64", versions: { stable: "8.0.72" }, revision: 0 }] });
  const run = async (a: string[]) => {
    if (a[0] === "brew" && a[1] === "info" && n++ === 0) throw Object.assign(Error("x"), { code: "ETIMEDOUT" });
    if (a[0] === "brew") return info;
    throw Object.assign(Error("x"), { status: 1 }); // the sampler is not under test here
  };
  const out = await check(run, async () => {}, 1, 3, false);
  expect(out).toMatchObject({ installed: "8.0.64", available: "8.0.72" }); expect(out.versionError).toBeUndefined(); expect(n).toBe(2);
});

// ---- Pass criterion 2: after a successful upgrade, one or two timeouts at the link check change nothing.

for (const times of [1, 2]) test(`enabled: ${times} timeout(s) at the link check after a good upgrade: upgraded, no rollback, nothing marked failed`, async () => {
  const { run } = await runMod(); let upgraded = false;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { upgraded = true; }; });
  const s = slowRead(1, times, () => upgraded); w.slow = s.slow;
  const out = await run(w.deps(), target);
  expect(s.fired).toBe(times);
  expect(outcome(out, dir, w)).toEqual({ decision: "upgraded", reason: "probe_passed", failed: [], halted: undefined, linked: "8.0.70", kegs: ["8.0.64", "8.0.70"], running: "8.0.70" });
  expect(flat(w)).not.toContain("brew unlink");
  rmSync(dir, { recursive: true });
});
test("enabled: three timeouts at the link check behave as today: rolled back, link_unreadable, version marked failed", async () => {
  const { run } = await runMod(); let upgraded = false;
  const { dir, w, target } = await setup(true, w => { w.afterUpgrade = () => { upgraded = true; }; });
  const s = slowRead(1, 3, () => upgraded); w.slow = s.slow;
  const out = await run(w.deps(), target);
  expect(outcome(out, dir, w)).toMatchObject({ decision: "rolled_back", reason: "link_unreadable", failed: ["8.0.70"], halted: undefined, linked: "8.0.64" });
  expect(out.upgrade?.commandError).toEqual({ step: "brew_info", kind: "timed_out" });
  rmSync(dir, { recursive: true });
});

// ---- Pass criterion 3: inside a rollback or a recovery, one or two timeouts no longer end in halted.

// After the upgrade: read 1 is the link check, reads 2..5 are the rollback's (--cellar, info, info after the relink, final info).
for (const n of [2, 3, 4, 5]) for (const times of [1, 2]) test(`rollback: ${times} timeout(s) at its read ${n - 1} give the same rollback as none`, async () => {
  const { run } = await runMod();
  const mk = async () => { let upgraded = false; const x = await setup(true, w => { w.probeBroken.add("8.0.70"); w.afterUpgrade = () => { upgraded = true; }; }); return { ...x, armed: () => upgraded }; };
  const base = await mk(); const want = outcome(await run(base.w.deps(), base.target), base.dir, base.w);
  expect(want).toMatchObject({ decision: "rolled_back", reason: "probe_failed", failed: ["8.0.70"], halted: undefined, linked: "8.0.64" });
  const { dir, w, target, armed } = await mk(); const s = slowRead(n, times, armed); w.slow = s.slow;
  const out = await run(w.deps(), target);
  expect(s.fired).toBe(times); expect(outcome(out, dir, w)).toEqual(want);
  for (const d of [base.dir, dir]) rmSync(d, { recursive: true });
});
test("rollback: three timeouts in a row at one of its reads behave as today: rollback_failed, halted", async () => {
  const { run } = await runMod(); let upgraded = false;
  const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); w.afterUpgrade = () => { upgraded = true; }; });
  const s = slowRead(2, 3, () => upgraded); w.slow = s.slow;
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "rollback_failed", reason: "probe_failed" }); expect(state(dir).halted).toMatchObject({ reason: "rollback_failed" });
  rmSync(dir, { recursive: true });
});

// A rollback whose relink fails (nonzero) puts the moved keg back, then checks opt before halting. After the upgrade:
// read 1 is the link check, 2-3 the rollback's, 4 is putBack's (is the keg home?), 5 is ensureOpt's (is opt runnable?).
for (const [n, site] of [[4, "putBack"], [5, "ensureOpt"]] as const) for (const times of [1, 2]) test(`failed relink: ${times} timeout(s) at the ${site} read give the same halt as none`, async () => {
  const { run } = await runMod();
  const mk = async () => { let upgraded = false; const x = await setup(true, w => { w.probeBroken.add("8.0.70"); w.fail.add("link-once"); w.afterUpgrade = () => { upgraded = true; }; }); return { ...x, armed: () => upgraded }; };
  const base = await mk(); const want = outcome(await run(base.w.deps(), base.target), base.dir, base.w);
  expect(want).toMatchObject({ decision: "rollback_failed", reason: "probe_failed", halted: "rollback_failed", linked: "8.0.70", kegs: ["8.0.64", "8.0.70"] });
  const { dir, w, target, armed } = await mk(); const s = slowRead(n, times, armed); w.slow = s.slow;
  const out = await run(w.deps(), target);
  expect(s.fired).toBe(times); expect(outcome(out, dir, w)).toEqual(want);
  expect(state(dir).halted.opt).toEqual(state(base.dir).halted.opt); expect(state(dir).halted.opt).toMatchObject({ version: "8.0.70", runnable: true });
  for (const d of [base.dir, dir]) rmSync(d, { recursive: true });
});

// Recovery after a killed run. While probing: read 1 is the fence's --cellar, reads 2.. are the rollback's.
// While saving (partial save): read 1 is the fence's --cellar, read 2 the check that nothing was upgraded.
for (const [step, reads, expected] of [
  ["probing", 5, { decision: "recovered", reason: "interrupted_at_probing", failed: ["8.0.70"], halted: undefined, linked: "8.0.64", running: "8.0.64" }],
  ["saving", 2, { decision: "recovered", reason: "discarded_partial_save", failed: [], halted: undefined, linked: "8.0.64", running: "8.0.64" }],
] as const) for (let n = 1; n <= reads; n++) for (const times of [1, 2]) test(`recovery (killed while ${step}): ${times} timeout(s) at its read ${n} give the same recovery as none`, async () => {
  const { run } = await runMod();
  const killed = async () => {
    const x = await setup(true); let armed = step === "saving"; x.w.afterUpgrade = () => { armed = true; };
    x.w.hang = a => armed && a[0] === (step === "saving" ? "ditto" : "probe"); void run(x.w.deps(), x.target); await until(x.dir, step);
    x.w.procs.clear(); if (step !== "saving") x.w.respawn(); x.w.hang = undefined; x.w.calls = []; x.w.limits = [];
    return x;
  };
  const base = await killed(); const want = outcome(await run(base.w.deps(), base.target), base.dir, base.w);
  expect(want).toMatchObject(expected);
  const { dir, w, target } = await killed(); const s = slowRead(n, times); w.slow = s.slow;
  const out = await run(w.deps(), target);
  expect(s.fired).toBe(times); expect(outcome(out, dir, w)).toEqual(want);
  for (const d of [base.dir, dir]) rmSync(d, { recursive: true });
});

// ---- Pass criterion 4: brew link and brew unlink get 120 s and one try. The runner waits only for the process it
// spawned, so a second try could start while something the first one started still writes (review C, B1).

test("rollback: brew link and brew unlink reach the runner with a 120 s limit", async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); });
  expect((await run(w.deps(), target)).decision).toBe("rolled_back");
  expect(limitsOf(w, "unlink")).toEqual([120_000]); expect(limitsOf(w, "link")).toEqual([120_000]);
  expect(limitsOf(w, "update")).toEqual([120_000]); // unchanged: one try
  rmSync(dir, { recursive: true });
});
for (const sub of ["link", "unlink"]) test(`rollback: a timed-out brew ${sub} is NOT repeated: it ends as a failed rollback does today`, async () => {
  const { run } = await runMod(); let left = 1;
  const { dir, w, target } = await setup(true, w => { w.probeBroken.add("8.0.70"); });
  w.slow = a => a[0] === "brew" && a[1] === sub && left-- > 0;
  const out = await run(w.deps(), target);
  // putBack moves the newer keg home and relinks it (its own link call), then the halt records where opt points.
  expect(outcome(out, dir, w)).toMatchObject({ decision: "rollback_failed", reason: "probe_failed", failed: ["8.0.70"], halted: "rollback_failed", linked: "8.0.70", kegs: ["8.0.64", "8.0.70"] });
  expect(state(dir).halted).toMatchObject({ reason: "rollback_failed", version: "8.0.70", commandError: { step: `brew_${sub}`, kind: "timed_out" }, opt: { version: "8.0.70", runnable: true } });
  const timings = (out as { timings?: { step: string; ms: number; tries: number }[] }).timings!;
  expect(timings).toContainEqual({ step: `brew_${sub}`, ms: 120_000, tries: 1 });
  expect(timings.every(t => !(t.step === `brew_${sub}` && t.tries > 1))).toBe(true);
  expect(limitsOf(w, sub)).toEqual(sub === "link" ? [120_000, 120_000] : [120_000]); // link: the timed-out try, then putBack's relink
  expect(flat(w)[flat(w).indexOf(`brew ${sub}`) + 1]).not.toBe(`brew ${sub}`); // nothing re-runs it straight away
  rmSync(dir, { recursive: true });
});

// ---- Pass criterion 5: timings on every run line; a fallback parse_failure names its sampler step.

test("every run line records each Homebrew step with its duration and tries", async () => {
  const { run } = await runMod();
  const a = await setup(false); const dry = await run(a.w.deps(), a.target) as { timings?: { step: string; ms: number; tries: number }[] };
  expect(dry.timings?.map(t => t.step)).toEqual(["brew_update", "brew_info", "brew_--cellar"]);
  for (const t of dry.timings!) { expect(t.tries).toBe(1); expect(Number.isInteger(t.ms) && t.ms >= 0).toBe(true); }
  expect(state(a.dir).last.timings).toEqual(dry.timings);
  const b = await setup(true); const up = await run(b.w.deps(), b.target) as { decision: string; timings?: { step: string }[] };
  expect(up.decision).toBe("upgraded"); expect(up.timings?.map(t => t.step)).toEqual(["brew_update", "brew_info", "brew_--cellar", "brew_upgrade", "brew_info"]);
  for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true });
});
for (const [step, configure] of [
  ["nettop", (w: World, base: World["run"]) => { w.run = async (a, t, e) => a[0] === "nettop" ? "GARBAGE-OUTPUT\n" : base(a, t, e); }],
  ["launchctl_list", (w: World, base: World["run"]) => { w.run = async (a, t, e) => a[0] === "launchctl" && a[1] === "list" ? "GARBAGE-OUTPUT\n" : base(a, t, e); }],
  ["lsof_established", (w: World, base: World["run"]) => {
    w.run = async (a, t, e) => a[0] === "nettop" ? `,bytes_in,bytes_out,\ncliproxyapi.100,1,2,\ntcp4 127.0.0.1:8317<->127.0.0.1:6000,1,2,\ntcp4 127.0.0.1:8317<->*:*,,,\n`
      : a[0] === "lsof" && a.includes("-sTCP:ESTABLISHED") ? "GARBAGE-OUTPUT\n" : base(a, t, e);
  }],
] as const) test(`fallback parse_failure names the sampler step (${step}), never its output`, async () => {
  const { run } = await runMod(); const { dir, w, target } = await setup(false, w => { w.inflight = () => ({ status: 404, body: "" }); });
  (configure as (w: World, base: World["run"]) => void)(w, w.run);
  const out = await run(w.deps(), target);
  expect(out).toMatchObject({ decision: "busy_unknown", reason: "os_signal_unreadable", gate: { fallback: { lastReason: "parse_failure", parseStep: step } } });
  expect(JSON.stringify(out)).not.toContain("GARBAGE");
  rmSync(dir, { recursive: true });
});
