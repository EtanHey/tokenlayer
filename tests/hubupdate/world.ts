import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hubTarget } from "../../src/hubupdate/target";

export const MGMT = "mgmt-PRIVATE-KEY-MUST-NOT-LEAK", ACCESS = "access-PRIVATE-KEY-MUST-NOT-LEAK";
export const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" });
export const broken = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error" });
const newest = (kegs: Iterable<string>) => [...kegs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? null;

/**
 * A fake Homebrew + launchd + hub. Every command and HTTP call is recorded; brew/launchctl mutate the model.
 * `opt` is the opt symlink launchd executes (brew unlink leaves it; brew link and upgrade point it at the newest keg).
 * Long commands get a child PID in `procs` while they run; a hung command keeps its child alive.
 */
export class World {
  kegs = new Set(["8.0.64"]); linked: string | null = "8.0.64"; opt: string | null = "8.0.64"; stable = "8.0.70";
  running: { pid: number; version: string } | null = { pid: 100, version: "8.0.64" };
  calls: string[][] = []; envs: Record<string, string | undefined>[] = []; clock = Date.parse("2026-11-15T08:00:00Z");
  inflight: (poll: number) => { status: number; body: string } | "throw" = () => ({ status: 200, body: JSON.stringify({ in_flight: 0, by_provider: {} }) });
  polls = 0; fail = new Set<string>(); probeBroken = new Set<string>(); hang?: (args: string[]) => boolean; afterUpgrade?: () => void;
  procs = new Map<number, string>(); nextPid = 700; brewLock = false; onProbe?: () => void;
  /** The time limit each command was given, index-aligned with `calls` (undefined: the runner default). */
  limits: (number | undefined)[] = [];
  /** A command for which this returns true runs out its whole time limit and is killed (ETIMEDOUT), like a loaded Mac. */
  slow?: (args: string[]) => boolean;
  constructor(readonly dir: string) {}
  info() { return JSON.stringify({ formulae: [{ name: "cliproxyapi", linked_keg: this.linked, versions: { stable: this.stable }, revision: 0, installed: [...this.kegs].map(version => ({ version })) }] }); }
  /** launchd KeepAlive brings the service back on whatever opt points at. */
  respawn() { this.running = this.opt && this.kegs.has(this.opt) ? { pid: (this.running?.pid ?? 100) + 1, version: this.opt } : null; }
  run = async (args: string[], _timeout?: number, env?: Record<string, string | undefined>, onSpawn?: (pid: number) => void): Promise<string> => {
    this.calls.push(args); this.limits.push(_timeout); if (env) this.envs.push(env);
    if (this.slow?.(args)) { this.clock += _timeout ?? 15_000; throw Object.assign(Error("PRIVATE slow " + MGMT), { code: "ETIMEDOUT" }); }
    let child: number | undefined;
    if (onSpawn) { child = this.nextPid++; this.procs.set(child, `Sun Nov 15 08:00:${String(child % 60).padStart(2, "0")} 2026`); onSpawn(child); }
    if (this.hang?.(args)) return new Promise(() => {});
    try { return this.dispatch(args); } finally { if (child !== undefined) this.procs.delete(child); }
  };
  dispatch(args: string[]): string {
    const key = args.slice(0, 2).join(" ");
    if (this.fail.has(key)) throw Object.assign(Error("PRIVATE stderr " + MGMT), { code: key === "brew update" ? "ETIMEDOUT" : undefined });
    const [c, sub] = args, version = (p: string) => p.split("/").pop()!;
    if (c === "brew" && sub === "update") return "";
    if (c === "brew" && sub === "info") return this.info();
    if (c === "brew" && sub === "--cellar") return "/C/cliproxyapi\n";
    if (c === "brew" && sub === "fetch") return "";
    if (c === "brew" && sub === "upgrade") { this.kegs.add(this.stable); this.linked = this.opt = this.stable; this.afterUpgrade?.(); return ""; }
    if (c === "brew" && sub === "unlink") { this.linked = null; return ""; }
    if (c === "brew" && sub === "link") {
      if (this.fail.has("link-once")) { this.fail.delete("link-once"); throw Error("PRIVATE conflict"); }
      if (this.fail.has("link")) throw Error("PRIVATE conflict");
      this.linked = this.opt = newest(this.kegs); return "";
    }
    if (c === "rm") { this.kegs.delete(version(args[2])); return ""; }
    if (c === "mv") { if (args[1].startsWith("/C/cliproxyapi/")) this.kegs.delete(version(args[1])); if (args[2].startsWith("/C/cliproxyapi/")) this.kegs.add(version(args[2])); return ""; }
    if (c === "ditto") { if (this.fail.has("ditto")) throw Error("x"); if (args[2].startsWith("/C/cliproxyapi/")) this.kegs.add(version(args[2])); return ""; }
    if (c === "launchctl" && sub === "kickstart") {
      if (this.fail.has("kickstart")) throw Error("x");
      if (this.fail.has("nostart")) this.running = null; else this.respawn();
      return "";
    }
    if (c === "launchctl" && sub === "list") return "PID\tStatus\tLabel\n";
    if (c === "lsof" && args[1] === "-t") { if (this.brewLock) return "999\n"; throw Error("no holder"); }
    if (c === "lsof" && args.includes("-sTCP:LISTEN")) return this.running ? `p${this.running.pid}\nf13\n` : "";
    if (c === "lsof" && args.includes("txt")) return this.running ? `p${this.running.pid}\nftxt\nn/C/cliproxyapi/${this.fail.has("wrongexe") ? "8.0.1" : this.running.version}/bin/cliproxyapi\n` : "";
    if (c === "lsof") return "p555\nf3\nn127.0.0.1:6000->127.0.0.1:8317\n";
    if (c === "readlink") { if (!this.opt) throw Error("not a link"); return `../Cellar/cliproxyapi/${this.opt}\n`; }
    if (c === "ps" && args.includes("lstart=")) { const start = this.procs.get(Number(args.at(-1))); if (!start) throw Error("no such process"); return start + "\n"; }
    if (c === "ps") return "/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi\n";
    if (c === "nettop") return `,bytes_in,bytes_out,\ncliproxyapi.${this.running?.pid},1,2,\ntcp4 127.0.0.1:8317<->*:*,,,\n`;
    if (c === "probe") {
      this.onProbe?.();
      if (!this.running || this.probeBroken.has(this.running.version)) { if (this.fail.has("probe-exit")) throw Error("exit 1"); return broken; }
      return ok;
    }
    throw Error("unexpected command " + args.join(" "));
  }
  http = async (url: string, headers: Record<string, string>) => {
    this.calls.push(["GET", url.replace(/^https?:\/\/[^/]+/, "")]); this.limits.push(undefined);
    if (this.hang?.(["GET"])) return new Promise<never>(() => {});
    expect(headers.Authorization).toBe(`Bearer ${MGMT}`);
    const r = this.inflight(this.polls++); if (r === "throw") throw Object.assign(Error("timeout"), { name: "TimeoutError" }); return r;
  };
  deps(extra: Record<string, unknown> = {}) {
    return { run: this.run, http: this.http, sleep: async (ms: number) => { this.clock += ms; }, now: () => this.clock, uid: 501, pid: 4242,
      alive: (pid: number) => this.procs.has(pid), lock: () => () => {}, connect: async () => (this.running ? "open" : "refused") as "open" | "refused", env: { CLIPROXY_MGMT_KEY: MGMT, CLIPROXY_ACCESS_KEY: ACCESS }, log: () => {}, ...extra };
  }
  /** Commands that change something outside our own state directory. */
  mutations() { return this.calls.filter(a => (a[0] === "brew" && ["upgrade", "unlink", "link", "fetch", "uninstall", "cleanup", "services", "pin"].includes(a[1])) || a[0] === "rm" || a[0] === "mv" || a[0] === "ditto" || (a[0] === "launchctl" && a[1] !== "list")); }
}

export async function setup(enabled = true, configure: (w: World) => void = () => {}) {
  const dir = mkdtempSync(tmpdir() + "/hubrun-"), w = new World(dir); configure(w);
  writeFileSync(dir + "/hub.conf", "server:\n  port: 8317\n"); writeFileSync(dir + "/hub.plist", "<plist/>\n");
  if (enabled) writeFileSync(dir + "/enabled", "enabled\n");
  const target = { ...hubTarget("/home/x"), configPath: dir + "/hub.conf", plistPath: dir + "/hub.plist", stateDir: dir + "/state", enableFile: dir + "/enabled", probe: ["probe"] };
  return { dir, w, target };
}
export const state = (dir: string) => JSON.parse(readFileSync(dir + "/state/state.json", "utf8"));
export const peek = (dir: string) => { try { return state(dir); } catch { return {}; } };
export const seed = (dir: string, s: object) => { mkdirSync(dir + "/state", { recursive: true, mode: 0o700 }); writeFileSync(dir + "/state/state.json", JSON.stringify(s), { mode: 0o600 }); };
export const flat = (w: World) => w.calls.map(a => a[0] === "GET" ? "GET in-flight" : a.slice(0, a[0] === "brew" || a[0] === "launchctl" ? 2 : 1).join(" "));
/** Wait until a background run has written `step` into its journal. */
export async function until(dir: string, step: string) {
  for (let i = 0; i < 500 && peek(dir).journal?.step !== step; i++) await Bun.sleep(1);
  expect(peek(dir).journal?.step).toBe(step);
}
