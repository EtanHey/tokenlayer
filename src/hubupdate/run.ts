import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { kegState, versionPattern, versions } from "./core";
import { gate, type GateDeps, type GateResult } from "./gate";
import { command, failure } from "./probe";
import type { Target } from "./target";

export type Deps = GateDeps & { uid: number; pid: number; alive: (pid: number) => boolean; env: Record<string, string | undefined>; log: (line: string) => void };
type Step = "saving" | "upgrading" | "rechecking" | "restarting" | "verifying" | "probing" | "rolling_back";
type Journal = {
  id: string; from: string; to: string; step: Step; startedAt: string; updatedAt: string; oldPid?: number;
  configSha?: string; plistSha?: string; reason?: string; failedStep?: Step; markFailed?: boolean; halt?: string;
};
type State = {
  failed?: Record<string, { at: string; reason: string; step: string }>; lastSuccessAt?: string;
  lastSuccess?: { id: string; from: string; to: string; at: string }; halted?: { at: string; reason: string; version?: string; commandError?: unknown };
  journal?: Journal; last?: unknown;
};
type Fail = ReturnType<typeof failure>;
export type Result = {
  mode: "enabled" | "dry_run"; checkedAt: string; decision: string; reason?: string; refresh?: string; refreshError?: Fail; versionError?: Fail; runningError?: Fail;
  installed?: string | null; available?: string | null; gate?: GateResult; recheck?: GateResult; upgrade?: { id: string; from: string; to: string; step?: string; commandError?: Fail };
  failedVersions?: string[]; lastSuccessAt?: string; halted?: State["halted"];
};

// Homebrew must not delete the old keg (rollback source), touch other formulae, or auto-update mid-run.
const brewEnv = { HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1", HOMEBREW_NO_ENV_HINTS: "1" };

/** One `{"type":"result","subtype":"success","is_error":false}` event, from a single object or an event array. */
export function probeOk(text: string): boolean {
  let value: unknown; try { value = JSON.parse(text); } catch { return false; }
  const results = (Array.isArray(value) ? value : [value]).filter(e => (e as { type?: unknown })?.type === "result") as { subtype?: unknown; is_error?: unknown }[];
  return results.length === 1 && results[0].subtype === "success" && results[0].is_error === false;
}

const enabledFile = (path: string) => { try { return readFileSync(path, "utf8").trim() === "enabled"; } catch { return false; } };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function writePrivate(path: string, data: string | Buffer) {
  const temp = `${path}.${randomUUID()}`, fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, typeof data === "string" ? Buffer.from(data) : data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function privateDir(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }

export async function run(d: Deps, t: Target): Promise<Result> {
  const enabled = enabledFile(t.enableFile), mode = enabled ? "enabled" : "dry_run" as const;
  const base: Result = { mode, checkedAt: new Date(d.now()).toISOString(), decision: "busy_unknown" };
  try { privateDir(t.stateDir); } catch { return { ...base, reason: "state_dir_unwritable" }; }
  const lock = join(t.stateDir, "run.lock");
  if (!acquire(lock, d)) return { ...base, decision: "locked", reason: "another_run_holds_the_lock" };
  try {
    const path = join(t.stateDir, "state.json"); let state: State = {};
    if (existsSync(path)) try { state = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...base, reason: "state_unreadable" }; }
    const r = new Run(d, t, state, enabled, base);
    const out = await r.decide();
    Object.assign(out, { failedVersions: Object.keys(state.failed ?? {}), lastSuccessAt: state.lastSuccessAt, halted: state.halted });
    state.last = out; r.save();
    return out;
  } finally { rmSync(lock, { force: true }); }
}

function acquire(path: string, d: Deps): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(path, "wx", 0o600); writeSync(fd, JSON.stringify({ pid: d.pid, at: new Date(d.now()).toISOString() })); closeSync(fd); return true; }
    catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") return false;
      let holder: unknown; try { holder = JSON.parse(readFileSync(path, "utf8")).pid; } catch { /* unreadable lock: stale */ }
      if (Number.isInteger(holder) && d.alive(holder as number)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

class Run {
  constructor(readonly d: Deps, readonly t: Target, readonly state: State, readonly enabled: boolean, readonly base: Result) {}
  at = () => new Date(this.d.now()).toISOString();
  save() { writePrivate(join(this.t.stateDir, "state.json"), JSON.stringify(this.state) + "\n"); }
  log(event: string, fields: Record<string, unknown>) { this.d.log(JSON.stringify({ event, at: this.at(), ...fields })); }
  /** Record the step before doing it, so a killed run leaves the step it died in. */
  step(j: Journal, step: Step) { j.step = step; j.updatedAt = this.at(); this.state.journal = j; this.save(); this.log("step", { id: j.id, step, from: j.from, to: j.to }); }
  brew(args: string[], timeout = 15_000) { return command(this.d.run, ["brew", ...args], timeout, brewEnv); }
  async info() { return kegState(await this.brew(["info", "--json=v2", this.t.formula]), this.t.formula); }
  backup(id: string) { return join(this.t.stateDir, "backups", id); }

  async decide(): Promise<Result> {
    const { t, state, enabled, base } = this;
    if (state.halted) return { ...base, decision: "halted", reason: state.halted.reason };
    if (state.journal) return enabled ? this.recover(state.journal) : { ...base, decision: "interrupted_run_pending", reason: `journal_at_${state.journal.step}` };
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
    const key = this.d.env[t.mgmtKeyVar];
    if (!this.d.env[t.accessKeyVar]) return { ...seen, decision: "busy_unknown", reason: "access_key_missing" };
    const g = await gate(this.d, t, key, { confirmMs: t.confirmMs, pollMs: t.pollMs, waitMs: t.waitMs });
    if (g.verdict !== "idle") return { ...seen, decision: g.verdict, reason: g.reason, gate: g };
    if (!enabled) return { ...seen, decision: "would_upgrade_now", reason: g.reason, gate: g };
    return this.upgrade({ ...seen, gate: g }, rack, v.installed, v.available, pid!, key);
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
  restart() { return command(this.d.run, ["launchctl", "kickstart", "-k", `gui/${this.d.uid}/${this.t.label}`], 60_000); }
  async probe(): Promise<boolean> {
    const env = { ANTHROPIC_BASE_URL: this.t.hubUrl, ANTHROPIC_API_KEY: this.d.env[this.t.accessKeyVar], ANTHROPIC_AUTH_TOKEN: undefined, [this.t.mgmtKeyVar]: undefined, [this.t.accessKeyVar]: undefined };
    try { return probeOk(await command(this.d.run, this.t.probe, this.t.probeTimeoutMs, env, "probe")); } catch { return false; }
  }
  files() {
    const config = readFileSync(this.t.configPath), plist = readFileSync(this.t.plistPath);
    return { config, plist, configSha: sha(config), plistSha: sha(plist) };
  }

  async upgrade(seen: Result, rack: string, from: string, to: string, oldPid: number, key: string | undefined): Promise<Result> {
    const now = this.at(), id = `${now.replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`, dir = this.backup(id);
    const j: Journal = { id, from, to, step: "saving", startedAt: now, updatedAt: now, oldPid };
    const upgrade = { id, from, to };
    this.step(j, "saving");
    try {
      privateDir(join(this.t.stateDir, "backups")); privateDir(dir);
      const f = this.files(); j.configSha = f.configSha; j.plistSha = f.plistSha;
      writePrivate(join(dir, "config"), f.config); writePrivate(join(dir, "plist"), f.plist);
      await command(this.d.run, ["ditto", `${rack}/${from}`, join(dir, "keg")], 300_000);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true }); delete this.state.journal;
      this.log("failure", { id, reason: "save_failed", commandError: failure(error) });
      return { ...seen, decision: "save_failed", reason: "save_failed", upgrade: { ...upgrade, commandError: failure(error) } };
    }
    this.step(j, "upgrading");
    try { await this.brew(["upgrade", "--formula", this.t.formula], this.t.upgradeTimeoutMs); }
    catch (error) { return this.rollback(seen, j, "upgrade_failed", { commandError: failure(error) }); }
    try { if ((await this.info()).linked !== to) return this.rollback(seen, j, "link_mismatch"); }
    catch (error) { return this.rollback(seen, j, "link_mismatch", { commandError: failure(error) }); }
    let same = false; try { const f = this.files(); same = f.configSha === j.configSha && f.plistSha === j.plistSha; } catch { /* unreadable counts as changed */ }
    if (!same) return this.rollback(seen, j, "config_changed", { halt: "config_changed" });
    this.step(j, "rechecking");
    const recheck = await gate(this.d, this.t, key, { confirmMs: this.t.recheckConfirmMs, pollMs: this.t.pollMs, waitMs: this.t.recheckWaitMs, fallbackWindowS: this.t.recheckFallbackWindowS, fallbackSamples: this.t.recheckFallbackSamples });
    if (recheck.verdict !== "idle") return this.rollback({ ...seen, recheck }, j, "busy_before_restart", { markFailed: false });
    this.step(j, "restarting");
    try { await this.restart(); } catch (error) { return this.rollback({ ...seen, recheck }, j, "restart_failed", { commandError: failure(error) }); }
    const pid = await this.waitListener(oldPid);
    if (pid === undefined) return this.rollback({ ...seen, recheck }, j, "listener_timeout");
    this.step(j, "verifying");
    let running: string | undefined; try { running = await this.exe(rack, pid); } catch { /* unreadable is a mismatch */ }
    if (running !== to) return this.rollback({ ...seen, recheck }, j, "version_mismatch");
    this.step(j, "probing");
    if (!(await this.probe())) return this.rollback({ ...seen, recheck }, j, "probe_failed");
    const at = this.at();
    this.state.lastSuccessAt = at; this.state.lastSuccess = { id, from, to, at }; delete this.state.journal;
    this.prune(id); this.log("upgraded", { id, from, to });
    return { ...seen, recheck, decision: "upgraded", reason: "probe_passed", upgrade };
  }

  /** Back to `from`: restore its keg if Homebrew removed it, drop `to`, relink, restart only if needed, probe. */
  async rollback(seen: Result, j: Journal, reason: string, o: { markFailed?: boolean; halt?: string; commandError?: Fail } = {}): Promise<Result> {
    const markFailed = o.markFailed ?? true, failedStep = j.step === "rolling_back" ? j.failedStep ?? j.step : j.step;
    Object.assign(j, { reason, failedStep, markFailed, halt: o.halt });
    this.log("failure", { id: j.id, reason, step: failedStep, from: j.from, to: j.to, commandError: o.commandError });
    this.step(j, "rolling_back");
    const upgrade = { id: j.id, from: j.from, to: j.to, step: failedStep, commandError: o.commandError };
    try {
      const rack = await this.rack(); let keg = await this.info();
      if (!keg.kegs.includes(j.from)) { await command(this.d.run, ["ditto", join(this.backup(j.id), "keg"), `${rack}/${j.from}`], 300_000); keg = await this.info(); }
      if (keg.linked !== j.from || keg.kegs.includes(j.to)) {
        if (keg.linked) await this.brew(["unlink", this.t.formula]);
        if (keg.kegs.includes(j.to)) {
          if (j.to === j.from || !versionPattern.test(j.to)) throw Error("refusing_to_remove");
          await command(this.d.run, ["rm", "-rf", `${rack}/${j.to}`]);
        }
        await this.brew(["link", this.t.formula]);
      }
      keg = await this.info();
      if (keg.linked !== j.from || keg.kegs.includes(j.to) || !keg.kegs.includes(j.from)) throw Error("rollback_inconsistent");
      let pid = await this.listener(), running = pid ? await this.exe(rack, pid) : undefined;
      if (running !== j.from) {
        await this.restart(); pid = await this.waitListener(pid);
        running = pid ? await this.exe(rack, pid) : undefined;
        if (running !== j.from) throw Error("rollback_not_running");
      }
      if (!(await this.probe())) throw Error("rollback_probe_failed");
    } catch (error) {
      if (markFailed) (this.state.failed ??= {})[j.to] = { at: this.at(), reason, step: failedStep };
      this.state.halted = { at: this.at(), reason: "rollback_failed", version: j.to, commandError: failure(error) };
      this.save(); this.log("rollback_failed", { id: j.id, reason, commandError: failure(error) });
      return { ...seen, decision: "rollback_failed", reason, upgrade };
    }
    if (markFailed) (this.state.failed ??= {})[j.to] = { at: this.at(), reason, step: failedStep };
    if (j.halt) this.state.halted = { at: this.at(), reason: j.halt, version: j.to };
    delete this.state.journal; this.prune(); this.log("rolled_back", { id: j.id, reason, from: j.from, to: j.to });
    return { ...seen, decision: markFailed ? "rolled_back" : "aborted_busy", reason, upgrade };
  }

  /** A journal left by a killed run. Never upgrades in the same run. */
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
    return r.decision === "rollback_failed" ? r : { ...r, decision: "recovered" };
  }

  /** Keep only the backup of the current version's predecessor (`keep`); our own folder only. */
  prune(keep?: string) {
    const root = join(this.t.stateDir, "backups"); if (!existsSync(root)) return;
    for (const name of readdirSync(root)) if (name !== keep) rmSync(join(root, name), { recursive: true, force: true });
  }
}
