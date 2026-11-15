import { chmodSync, closeSync, constants, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { kegState, versionPattern, versions } from "./core";
import { gate, type GateDeps, type GateResult } from "./gate";
import { command, CommandError, failure } from "./probe";
import type { Target } from "./target";

/** Takes the run lock at `path`; returns its release function, or undefined when another run holds it. */
export type Lock = (path: string) => (() => void) | undefined;
export type Deps = GateDeps & { uid: number; pid?: number; alive: (pid: number) => boolean; env: Record<string, string | undefined>; log: (line: string) => void; lock?: Lock };
type Step = "saving" | "upgrading" | "rechecking" | "restarting" | "verifying" | "probing" | "rolling_back";
/** A long external command, recorded before waiting on it, so a later run can tell whether it outlived its run. */
type Child = { cmd: string; pid: number; start?: string; since: string };
type Journal = {
  id: string; from: string; to: string; step: Step; startedAt: string; updatedAt: string; oldPid?: number; kegsBefore?: string[];
  configSha?: string; plistSha?: string; configMode?: number; plistMode?: number; child?: Child; aside?: string[];
  reason?: string; failedStep?: Step; markFailed?: boolean; halt?: string; pendingSince?: string;
};
type State = {
  failed?: Record<string, { at: string; reason: string; step: string }>; lastSuccessAt?: string;
  lastSuccess?: { id: string; from: string; to: string; at: string }; halted?: { at: string; reason: string; version?: string; commandError?: unknown };
  journal?: Journal; last?: unknown; cleared?: { at: string; what: string }[];
};
type Fail = ReturnType<typeof failure>;
export type Result = {
  mode: "enabled" | "dry_run"; checkedAt: string; decision: string; reason?: string; what?: string; refresh?: string; refreshError?: Fail; versionError?: Fail; runningError?: Fail;
  forced?: { reason: string; waitedMs: number; limitMs: number; gate: string };
  installed?: string | null; available?: string | null; gate?: GateResult; recheck?: GateResult; upgrade?: { id: string; from: string; to: string; step?: string; commandError?: Fail };
  failedVersions?: string[]; lastSuccessAt?: string; halted?: State["halted"];
};

/** The new version failed real requests, its version check, or never came up: its rollback may cut a stream sooner. */
const UNHEALTHY = new Set(["probe_failed", "version_mismatch", "listener_timeout"]);

// Homebrew must not delete the old keg (rollback source), touch other formulae, or auto-update mid-run.
const brewEnv = { HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1", HOMEBREW_NO_ENV_HINTS: "1" };

/** One `{"type":"result","subtype":"success","is_error":false}` event, from a single object or an event array. */
export function probeOk(text: string): boolean {
  let value: unknown; try { value = JSON.parse(text); } catch { return false; }
  const results = (Array.isArray(value) ? value : [value]).filter(e => (e as { type?: unknown })?.type === "result") as { subtype?: unknown; is_error?: unknown }[];
  return results.length === 1 && results[0].subtype === "success" && results[0].is_error === false;
}

const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
let libc: { flock: (fd: number, op: number) => number } | undefined;
function flock(fd: number, op: number): number {
  libc ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols as unknown as typeof libc;
  return libc!.flock(fd, op);
}
/**
 * A kernel flock: acquisition is atomic, the kernel drops it when the holder dies (so there is no stale lock to
 * reclaim and PID reuse cannot fake a holder), and only the holder can release it. The file is never deleted.
 */
export const flockLock: Lock = path => {
  let fd: number; try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600); } catch { return undefined; }
  if (flock(fd, LOCK_EX | LOCK_NB) !== 0) { closeSync(fd); return undefined; }
  try { ftruncateSync(fd, 0); writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", 0); } catch { /* holder note only */ }
  return () => { flock(fd, LOCK_UN); closeSync(fd); };
};

const enabledFile = (path: string) => { try { return readFileSync(path, "utf8").trim() === "enabled"; } catch { return false; } };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const newer = (a: string, b: string) => {
  const x = a.split(/[._]/).map(Number), y = b.split(/[._]/).map(Number);
  return (Array.from({ length: Math.max(x.length, y.length) }, (_, i) => (x[i] ?? 0) - (y[i] ?? 0)).find(n => n !== 0) ?? 0) > 0;
};
/** Atomic replace through a temp file in the same folder, fsynced, with an exact mode. */
function writeAtomic(path: string, data: string | Buffer, mode: number) {
  const temp = `${path}.${randomUUID()}`, fd = openSync(temp, "wx", mode);
  try { writeSync(fd, typeof data === "string" ? Buffer.from(data) : data); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(temp, mode); renameSync(temp, path);
}
function privateDir(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }

function baseResult(d: Deps, t: Target): Result {
  return { mode: enabledFile(t.enableFile) ? "enabled" : "dry_run", checkedAt: new Date(d.now()).toISOString(), decision: "busy_unknown" };
}
/** Runs `body` holding the run lock with the loaded state; saves the state afterwards. */
async function withState(d: Deps, t: Target, base: Result, body: (state: State, save: () => void) => Promise<Result>): Promise<Result> {
  try { privateDir(t.stateDir); } catch { return { ...base, reason: "state_dir_unwritable" }; }
  const release = (d.lock ?? flockLock)(join(t.stateDir, "run.lock"));
  if (!release) return { ...base, decision: "locked", reason: "another_run_holds_the_lock" };
  try {
    const path = join(t.stateDir, "state.json"); let state: State = {};
    if (existsSync(path)) try { state = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...base, reason: "state_unreadable" }; }
    const save = () => writeAtomic(path, JSON.stringify(state) + "\n", 0o600);
    const out = await body(state, save);
    Object.assign(out, { failedVersions: Object.keys(state.failed ?? {}), lastSuccessAt: state.lastSuccessAt, halted: state.halted });
    return out;
  } finally { release(); }
}

export async function run(d: Deps, t: Target): Promise<Result> {
  const base = baseResult(d, t);
  return withState(d, t, base, async (state, save) => {
    const r = new Run(d, t, state, base.mode === "enabled", base, save);
    const out = await r.decide();
    state.last = out; save();
    return out;
  });
}

/** Clear one failed version, or the halt, by hand; recorded in `cleared` and logged. */
export async function clear(d: Deps, t: Target, what: { failed?: string; halt?: boolean }): Promise<Result> {
  const base = baseResult(d, t);
  return withState(d, t, base, async (state, save) => {
    const at = new Date(d.now()).toISOString(); let label: string | undefined;
    if (what.failed && state.failed?.[what.failed]) { delete state.failed[what.failed]; label = `failed:${what.failed}`; }
    else if (what.halt && state.halted) { label = `halt:${state.halted.reason}`; delete state.halted; }
    if (!label) return { ...base, decision: "nothing_to_clear" };
    (state.cleared ??= []).push({ at, what: label }); save();
    d.log(JSON.stringify({ event: "cleared", at, what: label }));
    return { ...base, decision: "cleared", what: label };
  });
}

class Run {
  constructor(readonly d: Deps, readonly t: Target, readonly state: State, readonly enabled: boolean, readonly base: Result, readonly save: () => void) {}
  at = () => new Date(this.d.now()).toISOString();
  log(event: string, fields: Record<string, unknown>) { this.d.log(JSON.stringify({ event, at: this.at(), ...fields })); }
  /** Record the step before doing it, so a killed run leaves the step it died in. */
  step(j: Journal, step: Step) { j.step = step; j.updatedAt = this.at(); this.state.journal = j; this.save(); this.log("step", { id: j.id, step, from: j.from, to: j.to }); }
  brew(args: string[], timeout = 15_000) { return command(this.d.run, ["brew", ...args], timeout, brewEnv); }
  async info() { return kegState(await this.brew(["info", "--json=v2", this.t.formula]), this.t.formula); }
  backup(id: string) { return join(this.t.stateDir, "backups", id); }
  aside(j: Journal) { return join(this.backup(j.id), "aside"); }
  gateOptions() { return { confirmMs: this.t.confirmMs, pollMs: this.t.pollMs, waitMs: this.t.waitMs }; }

  /** A long command: its PID and start time go into the journal before we wait on it. */
  async long(j: Journal, cmd: string, args: string[], timeout: number, env?: Record<string, string | undefined>) {
    const onSpawn = (pid: number) => {
      j.child = { cmd, pid, since: this.at() }; this.save();
      void this.procStart(pid).then(start => { if (start && j.child?.pid === pid) { j.child.start = start; this.save(); } });
    };
    try { return await command(this.d.run, args, timeout, env, cmd, onSpawn); }
    finally { if (j.child) { delete j.child; this.save(); } }
  }
  async procStart(pid: number) { try { return (await command(this.d.run, ["ps", "-o", "lstart=", "-p", String(pid)])).trim() || undefined; } catch { return undefined; } }
  /** Same PID and same start time: the recorded child itself, not a process that reused its PID. */
  async childAlive(c: Child) {
    if (!this.d.alive(c.pid)) return false;
    const start = await this.procStart(c.pid);
    return start !== undefined && (c.start === undefined || start === c.start);
  }
  /** Homebrew holds an flock on <prefix>/var/homebrew/locks/<formula>.formula.lock while it installs or links. */
  async brewLocked(rack: string) {
    const path = join(dirname(dirname(rack)), "var/homebrew/locks", `${this.t.formula}.formula.lock`);
    try { return /\d/.test(await command(this.d.run, ["lsof", "-t", path])); }
    catch (error) { return !(error instanceof CommandError && error.kind === "nonzero"); } // lsof exits 1 when nobody has it open
  }

  async decide(): Promise<Result> {
    const { t, state, enabled, base } = this;
    if (state.halted) return { ...base, decision: "halted", reason: state.halted.reason };
    if (state.journal) {
      if (!enabled) return { ...base, decision: "interrupted_run_pending", reason: `journal_at_${state.journal.step}` };
      return (await this.fence(state.journal)) ?? this.recover(state.journal);
    }
    let refresh = "ok", refreshError: Fail, versionError: Fail, v: ReturnType<typeof versions> | undefined;
    try { await this.brew(["update"], 120_000); } catch (error) { refresh = "failed"; refreshError = failure(error); }
    try { v = versions(await this.brew(["info", "--json=v2", t.formula]), t.formula); } catch (error) { versionError = failure(error); }
    const seen: Result = { ...base, refresh, refreshError, versionError, installed: v?.installed ?? null, available: v?.available ?? null };
    if (!v) return { ...seen, reason: "version_unreadable" };
    if (!v.newer) return { ...seen, decision: "up_to_date", reason: "installed_not_older" };
    if (state.failed?.[v.available]) return { ...seen, decision: "version_failed", reason: state.failed[v.available].reason };
    if (refresh !== "ok") return { ...seen, decision: "refresh_failed", reason: "refresh_failed" };
    if (state.lastSuccessAt && this.d.now() - Date.parse(state.lastSuccessAt) < t.minIntervalMs) return { ...seen, decision: "rate_limited", reason: "upgraded_within_interval" };
    let rack: string, pid: number | undefined, running: string | undefined;
    try { rack = await this.rack(); pid = await this.listener(); running = pid ? await this.exe(rack, pid) : undefined; }
    catch (error) { return { ...seen, reason: "running_unreadable", runningError: failure(error) }; }
    if (running !== v.installed) return { ...seen, decision: "running_mismatch", reason: pid ? "running_is_not_linked_keg" : "no_listener" };
    if (await this.brewLocked(rack)) return { ...seen, decision: "brew_busy", reason: "brew_lock_held" };
    const key = this.d.env[t.mgmtKeyVar];
    if (!this.d.env[t.accessKeyVar]) return { ...seen, decision: "busy_unknown", reason: "access_key_missing" };
    const g = await gate(this.d, t, key, this.gateOptions());
    if (g.verdict !== "idle") return { ...seen, decision: g.verdict, reason: g.reason, gate: g };
    if (!enabled) return { ...seen, decision: "would_upgrade_now", reason: g.reason, gate: g };
    // If the running version fails the probe too, the probe (quota, upstream) is the problem, not the new version.
    if (!(await this.probe())) return { ...seen, decision: "probe_baseline_failed", reason: "probe_failed_on_running_version", gate: g };
    return this.upgrade({ ...seen, gate: g }, rack, v.installed, v.available, v.kegs, pid!, key);
  }

  /** A command of the dead run may still be changing things: change nothing while it lives; halt if it lives too long. */
  async fence(j: Journal): Promise<Result | undefined> {
    let rack: string | undefined; try { rack = await this.rack(); } catch { /* the rollback reports an unreadable cellar */ }
    const live = j.child ? await this.childAlive(j.child) : false;
    const locked = !live && rack ? await this.brewLocked(rack) : false;
    if (!live && !locked) { if (j.child) { delete j.child; this.save(); } return undefined; }
    const reason = live ? j.child!.cmd : "brew_lock_held", since = Date.parse(live ? j.child!.since : j.updatedAt ?? j.startedAt);
    if (this.d.now() - since > this.t.orphanHaltMs) {
      this.state.halted = { at: this.at(), reason: "orphan_command", version: j.to };
      this.log("halted", { id: j.id, reason: "orphan_command", command: reason, pid: live ? j.child!.pid : undefined });
      return { ...this.base, decision: "halted", reason: "orphan_command" };
    }
    this.log("command_still_running", { id: j.id, command: reason, pid: live ? j.child!.pid : undefined, step: j.step });
    return { ...this.base, decision: "command_still_running", reason };
  }

  async rack() {
    const rack = (await this.brew(["--cellar", this.t.formula])).trim();
    if (!rack.startsWith("/") || !rack.endsWith(`/${this.t.formula}`) || rack.includes("..")) throw Error("cellar_unreadable");
    return rack;
  }
  async listener(): Promise<number | undefined> {
    let out: string; try { out = await command(this.d.run, ["lsof", "-nP", `-iTCP:${this.t.port}`, "-sTCP:LISTEN", "-Fp"]); } catch { return undefined; } // lsof exits 1 when nothing listens
    const pids = [...new Set(out.match(/^p\d+$/gm) ?? [])]; return pids.length === 1 ? Number(pids[0].slice(1)) : undefined;
  }
  /** The keg version the running process was executed from (the kernel resolves the opt symlink). */
  async exe(rack: string, pid: number): Promise<string | undefined> {
    const path = (await command(this.d.run, ["lsof", "-nP", "-p", String(pid), "-a", "-d", "txt", "-Fn"])).split("\n").find(l => l.startsWith("n"))?.slice(1);
    if (!path?.startsWith(rack + "/")) return undefined;
    const version = path.slice(rack.length + 1).split("/")[0]; return versionPattern.test(version) ? version : undefined;
  }
  async waitListener(old: number | undefined): Promise<number | undefined> {
    const start = this.d.now();
    for (;;) {
      const pid = await this.listener(); if (pid !== undefined && pid !== old) return pid;
      if (this.d.now() - start >= this.t.restartWaitMs) return undefined;
      await this.d.sleep(1_000);
    }
  }
  restart(j: Journal) { return this.long(j, "launchctl_kickstart", ["launchctl", "kickstart", "-k", `gui/${this.d.uid}/${this.t.label}`], 60_000); }
  async probe(j?: Journal): Promise<boolean> {
    const env = { ANTHROPIC_BASE_URL: this.t.hubUrl, ANTHROPIC_API_KEY: this.d.env[this.t.accessKeyVar], ANTHROPIC_AUTH_TOKEN: undefined, [this.t.mgmtKeyVar]: undefined, [this.t.accessKeyVar]: undefined };
    try { return probeOk(j ? await this.long(j, "probe", this.t.probe, this.t.probeTimeoutMs, env) : await command(this.d.run, this.t.probe, this.t.probeTimeoutMs, env, "probe")); }
    catch { return false; }
  }
  files() {
    const config = readFileSync(this.t.configPath), plist = readFileSync(this.t.plistPath);
    return { config, plist, configSha: sha(config), plistSha: sha(plist), configMode: statSync(this.t.configPath).mode & 0o7777, plistMode: statSync(this.t.plistPath).mode & 0o7777 };
  }
  sameFiles(j: Journal) { try { const f = this.files(); return f.configSha === j.configSha && f.plistSha === j.plistSha; } catch { return false; } }
  /** Put the saved config and plist back (bytes and mode) wherever they differ, and prove it by hash. */
  restoreFiles(j: Journal) {
    for (const [path, name, hash, mode] of [[this.t.configPath, "config", j.configSha, j.configMode], [this.t.plistPath, "plist", j.plistSha, j.plistMode]] as const) {
      if (!hash) throw Error("backup_hash_missing");
      let current: string | undefined; try { current = sha(readFileSync(path)); } catch { /* missing counts as different */ }
      let currentMode: number | undefined; try { currentMode = statSync(path).mode & 0o7777; } catch { /* idem */ }
      if (current === hash && currentMode === mode) continue;
      const bytes = readFileSync(join(this.backup(j.id), name));
      if (sha(bytes) !== hash) throw Error("backup_corrupt");
      writeAtomic(path, bytes, mode ?? 0o644);
      if (sha(readFileSync(path)) !== hash) throw Error("restore_unverified");
      this.log("restored", { id: j.id, file: name });
    }
  }

  async upgrade(seen: Result, rack: string, from: string, to: string, kegsBefore: string[], oldPid: number, key: string | undefined): Promise<Result> {
    const now = this.at(), id = `${now.replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`, dir = this.backup(id);
    const j: Journal = { id, from, to, step: "saving", startedAt: now, updatedAt: now, oldPid, kegsBefore };
    const upgrade = { id, from, to };
    this.step(j, "saving");
    try {
      privateDir(join(this.t.stateDir, "backups")); privateDir(dir);
      const f = this.files(); Object.assign(j, { configSha: f.configSha, plistSha: f.plistSha, configMode: f.configMode, plistMode: f.plistMode });
      writeAtomic(join(dir, "config"), f.config, 0o600); writeAtomic(join(dir, "plist"), f.plist, 0o600); this.save();
      await this.long(j, "ditto", ["ditto", `${rack}/${from}`, join(dir, "keg")], 300_000);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true }); delete this.state.journal;
      this.log("failure", { id, reason: "save_failed", commandError: failure(error) });
      return { ...seen, decision: "save_failed", reason: "save_failed", upgrade: { ...upgrade, commandError: failure(error) } };
    }
    this.step(j, "upgrading");
    try { await this.long(j, "brew_upgrade", ["brew", "upgrade", "--formula", this.t.formula], this.t.upgradeTimeoutMs, brewEnv); }
    catch (error) { return this.rollback(seen, j, "upgrade_failed", { commandError: failure(error) }); }
    try { if ((await this.info()).linked !== to) return this.rollback(seen, j, "link_mismatch"); }
    catch (error) { return this.rollback(seen, j, "link_mismatch", { commandError: failure(error) }); }
    if (!this.sameFiles(j)) return this.rollback(seen, j, "config_changed", { halt: "config_changed" });
    this.step(j, "rechecking");
    // launchd KeepAlive may already have restarted the service on the new keg; that restart has happened.
    let pid = await this.listener(), recheck: GateResult | undefined;
    if (pid === oldPid) {
      recheck = await gate(this.d, this.t, key, { confirmMs: this.t.recheckConfirmMs, pollMs: this.t.pollMs, waitMs: this.t.recheckWaitMs, fallbackWindowS: this.t.recheckFallbackWindowS, fallbackSamples: this.t.recheckFallbackSamples });
      pid = await this.listener();
      if (pid === oldPid && recheck.verdict !== "idle") return this.rollback({ ...seen, recheck }, j, "busy_before_restart", { markFailed: false });
    }
    const after = { ...seen, recheck };
    this.step(j, "restarting");
    if (pid !== oldPid) this.log("self_restart", { id, oldPid, pid });
    else try { await this.restart(j); } catch (error) { return this.rollback(after, j, "restart_failed", { commandError: failure(error) }); }
    const newPid = await this.waitListener(oldPid);
    if (newPid === undefined) return this.rollback(after, j, "listener_timeout");
    this.step(j, "verifying");
    let running: string | undefined; try { running = await this.exe(rack, newPid); } catch { /* unreadable is a mismatch */ }
    if (running !== to) return this.rollback(after, j, "version_mismatch");
    this.step(j, "probing");
    if (!(await this.probe(j))) return this.rollback(after, j, "probe_failed");
    // The new version must not have rewritten its config or plist on start: that needs a person.
    if (!this.sameFiles(j)) return this.rollback(after, j, "config_changed", { halt: "config_changed" });
    const at = this.at();
    this.state.lastSuccessAt = at; this.state.lastSuccess = { id, from, to, at }; delete this.state.journal;
    this.prune(id); this.log("upgraded", { id, from, to });
    return { ...after, decision: "upgraded", reason: "probe_passed", upgrade };
  }

  /**
   * Back to `from`: restore its keg if Homebrew removed it; move newer kegs aside (deleted only once everything is
   * verified), relink, and put them back if that fails; restore config and plist; restart only when the hub is idle
   * or nothing listens; probe. A busy hub keeps the journal for the next run (`rollback_pending`).
   */
  async rollback(seen: Result, j: Journal, reason: string, o: { markFailed?: boolean; halt?: string; commandError?: Fail } = {}): Promise<Result> {
    const markFailed = o.markFailed ?? true, failedStep = j.step === "rolling_back" ? j.failedStep ?? j.step : j.step;
    Object.assign(j, { reason, failedStep, markFailed, halt: o.halt });
    this.log("failure", { id: j.id, reason, step: failedStep, from: j.from, to: j.to, commandError: o.commandError });
    this.step(j, "rolling_back");
    const upgrade = { id: j.id, from: j.from, to: j.to, step: failedStep, commandError: o.commandError };
    let forced: Result["forced"];
    try {
      const rack = await this.rack(); let keg = await this.info();
      if (!keg.kegs.includes(j.from)) { await this.long(j, "ditto", ["ditto", join(this.backup(j.id), "keg"), `${rack}/${j.from}`], 300_000); keg = await this.info(); }
      const ahead = keg.kegs.filter(v => newer(v, j.from)); // brew link would pick any of these over `from`
      if (keg.linked !== j.from || ahead.length) {
        const wasLinked = keg.linked !== null;
        if (wasLinked) await this.brew(["unlink", this.t.formula]);
        j.aside = [...new Set([...(j.aside ?? []), ...ahead])]; this.save();
        for (const v of ahead) { privateDir(this.aside(j)); await this.long(j, "mv", ["mv", `${rack}/${v}`, join(this.aside(j), v)], 300_000); }
        try {
          await this.brew(["link", this.t.formula]);
          if ((await this.info()).linked !== j.from) throw Error("rollback_link_mismatch");
        } catch (error) { await this.putBack(j, rack, wasLinked); throw error; }
      }
      keg = await this.info();
      if (keg.linked !== j.from || !keg.kegs.includes(j.from) || keg.kegs.some(v => newer(v, j.from))) throw Error("rollback_inconsistent");
      this.restoreFiles(j);
      let pid = await this.listener(), running = pid ? await this.exe(rack, pid) : undefined;
      if (running !== j.from) {
        if (pid !== undefined) {
          const g = await gate(this.d, this.t, this.d.env[this.t.mgmtKeyVar], this.gateOptions());
          if (g.verdict !== "idle") { // busy and unreadable alike
            const since = j.pendingSince ?? this.at(), waitedMs = this.d.now() - Date.parse(since);
            const limitMs = UNHEALTHY.has(reason) ? this.t.rollbackForceUnhealthyMs : this.t.rollbackForceMs;
            if (waitedMs < limitMs) {
              j.pendingSince = since; this.save();
              this.log("rollback_pending", { id: j.id, reason, gate: g.reason, since, waitedMs, limitMs });
              return { ...seen, decision: "rollback_pending", reason, gate: g, upgrade };
            }
            forced = { reason, waitedMs, limitMs, gate: g.reason };
            this.log("forced_rollback", { id: j.id, ...forced, since, from: j.from, to: j.to });
          }
        }
        await this.restart(j); pid = await this.waitListener(pid);
        running = pid ? await this.exe(rack, pid) : undefined;
        if (running !== j.from) throw Error("rollback_not_running");
      }
      if (!(await this.probe(j))) throw Error("rollback_probe_failed");
      if (!this.sameFiles(j)) j.halt ??= "config_changed"; // the old version rewrote it on start: a person looks
      for (const v of j.aside ?? []) if (j.kegsBefore?.includes(v)) await this.long(j, "mv", ["mv", join(this.aside(j), v), `${rack}/${v}`], 300_000);
    } catch (error) {
      if (markFailed) (this.state.failed ??= {})[j.to] = { at: this.at(), reason, step: failedStep };
      this.state.halted = { at: this.at(), reason: "rollback_failed", version: j.to, commandError: failure(error) };
      this.save(); this.log("rollback_failed", { id: j.id, reason, commandError: failure(error) });
      return { ...seen, decision: "rollback_failed", reason, upgrade, forced };
    }
    if (markFailed) (this.state.failed ??= {})[j.to] = { at: this.at(), reason, step: failedStep };
    if (j.halt) this.state.halted = { at: this.at(), reason: j.halt, version: j.to };
    delete this.state.journal; this.prune(); this.log("rolled_back", { id: j.id, reason, from: j.from, to: j.to });
    return { ...seen, decision: markFailed ? "rolled_back" : "aborted_busy", reason, upgrade, forced };
  }
  /** Undo a relink attempt: every keg moved aside goes back to the Cellar, and if something was linked, relink it. */
  async putBack(j: Journal, rack: string, relink: boolean) {
    const left: string[] = [];
    for (const v of j.aside ?? []) {
      try { if (!(await this.info()).kegs.includes(v)) await this.long(j, "mv", ["mv", join(this.aside(j), v), `${rack}/${v}`], 300_000); }
      catch { left.push(v); }
    }
    j.aside = left; this.save();
    if (relink) try { await this.brew(["link", this.t.formula]); } catch { /* opt still points at a keg that exists */ }
    this.log("put_back", { id: j.id, left });
  }

  /** A journal left by a killed run (its commands are known to be gone). Never upgrades in the same run. */
  async recover(j: Journal): Promise<Result> {
    this.log("recovering", { id: j.id, step: j.step, from: j.from, to: j.to });
    if (j.step === "saving") {
      try {
        const keg = await this.info();
        if (keg.linked === j.from && !keg.kegs.includes(j.to)) {
          rmSync(this.backup(j.id), { recursive: true, force: true }); delete this.state.journal;
          return { ...this.base, decision: "recovered", reason: "discarded_partial_save", upgrade: { id: j.id, from: j.from, to: j.to, step: "saving" } };
        }
      } catch { /* fall through to a full rollback */ }
    }
    const resumed = j.step === "rolling_back";
    const r = await this.rollback(this.base, j, resumed ? j.reason ?? "interrupted" : `interrupted_at_${j.step}`, { markFailed: resumed ? j.markFailed : true, halt: resumed ? j.halt : undefined });
    return r.decision === "rollback_failed" || r.decision === "rollback_pending" ? r : { ...r, decision: "recovered" };
  }

  /** Keep only the backup named `keep` (the predecessor of a successful upgrade); our own folder only. */
  prune(keep?: string) {
    const root = join(this.t.stateDir, "backups"); if (!existsSync(root)) return;
    for (const name of readdirSync(root)) if (name !== keep) rmSync(join(root, name), { recursive: true, force: true });
  }
}
