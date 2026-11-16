import { spawn, type ChildProcess } from "node:child_process";
import { blindSpots, idle, owners, parseNettop, sidecars, versions, type Idle, type Point } from "./core";
/**
 * `env` entries override the inherited environment; an `undefined` value removes that variable. Stdin is /dev/null.
 * `onSpawn` receives the child PID as soon as it exists, so a caller can record it before waiting.
 * On timeout the child gets SIGTERM, then SIGKILL 10 s later, and the promise settles only after it has exited.
 */
export type Runner = (args: string[], timeout?: number, env?: Record<string, string | undefined>, onSpawn?: (pid: number) => void) => Promise<string>;
const MAX_OUTPUT = 8 * 1024 * 1024;
export const runner: Runner = ([command, ...args], timeout = 15000, extra = {}, onSpawn) => new Promise((resolve, reject) => {
  const env: Record<string, string | undefined> = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  let child: ChildProcess;
  try { child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { reject(error); return; }
  let out = "", size = 0, settled = false, failure: string | undefined, kill: ReturnType<typeof setTimeout> | undefined;
  const settle = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(kill); error ? reject(error) : resolve(out); };
  const stop = (code: string) => { failure ??= code; child.kill("SIGTERM"); kill ??= setTimeout(() => child.kill("SIGKILL"), 10_000); };
  const timer = setTimeout(() => stop("ETIMEDOUT"), timeout);
  child.on("error", error => settle(error));
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { size += chunk.length; if (size > MAX_OUTPUT) stop("ENOBUFS"); else out += chunk; });
  child.stderr!.resume();
  child.on("exit", status => {
    const done = () => settle(failure ? Object.assign(Error("command_failure"), { code: failure }) : status === 0 ? undefined : Object.assign(Error("command_failure"), { status }));
    // A grandchild may hold stdout open; never wait on it for more than 2 s after the child itself exited.
    if (child.stdout!.readableEnded) done(); else { child.stdout!.once("end", done); setTimeout(done, 2_000); }
  });
  if (child.pid !== undefined) onSpawn?.(child.pid);
});
export class CommandError extends Error {
  constructor(readonly step: string, readonly kind: "timed_out" | "nonzero" | "spawn_failed") { super("command_failure"); }
}
const spawnCodes = new Set(["ENOENT", "EACCES", "ENOBUFS", "E2BIG"]);
const stepName = (args: string[]) => args[0] === "brew" ? `brew_${args[1]}` : args[0] === "lsof" ? (args.includes("-sTCP:LISTEN") ? "lsof_listen" : args.includes("txt") ? "lsof_exe" : "lsof_established") : args[0] === "launchctl" ? `launchctl_${args[1]}` : args[0];
export async function command(run: Runner, args: string[], timeout = 15000, env?: Record<string, string | undefined>, name?: string, onSpawn?: (pid: number) => void) {
  const step = name ?? stepName(args);
  try { return await run(args, timeout, env, onSpawn); }
  catch (error) {
    const code = (error as { code?: string })?.code;
    throw new CommandError(step, code === "ETIMEDOUT" ? "timed_out" : code && spawnCodes.has(code) ? "spawn_failed" : "nonzero");
  }
}
export const failure = (error: unknown) => error instanceof CommandError ? { step: error.step, kind: error.kind } : undefined;
/**
 * Time limits for a read-only Homebrew query (`brew info`, `brew --cellar`). On a loaded Mac these took 15 s and more
 * against 0.5 s normally (2026-11-15/16), so a timed-out read is tried again with a longer limit.
 */
export const READ_LIMITS = [15_000, 45_000, 90_000];
/** One Homebrew step of a run: how long it took in all, and how many tries it needed. */
export type Timing = { step: string; ms: number; tries: number };
/**
 * Runs `args` with `limits[0]`, and again with the next limit only while the try timed out. A nonzero exit, a spawn
 * failure or (for the caller) unparsable output is final. Appends one entry to `timings`, also when it fails.
 */
export async function retried(run: Runner, args: string[], limits: number[], env?: Record<string, string | undefined>, now: () => number = Date.now, timings?: Timing[]): Promise<string> {
  const start = now(); let tries = 0;
  try {
    for (;;) {
      try { return await command(run, args, limits[tries++], env); }
      catch (error) { if (!(error instanceof CommandError && error.kind === "timed_out") || tries >= limits.length) throw error; }
    }
  } finally { timings?.push({ step: stepName(args), ms: now() - start, tries }); }
}
/** On a `parse_failure`, `parseStep` names the sampler step whose output could not be parsed (never the output itself). */
export async function observe(run: Runner, sleep: (ms: number) => Promise<unknown>, window: number, count: number, port = 8317, name = "cliproxyapi"): Promise<Idle & { commandError?: ReturnType<typeof failure>; parseStep?: string }> {
  const samples: Point[][] = [], unattributed = new Set<string>(); let initial = 0, reason = "command_failure", parseStep = "";
  try {
    for (let i = 0; i < count; i++) {
      const pids = (await command(run, ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])).match(/^p\d+$/gm);
      reason = "pid_unreadable"; if (pids?.length !== 1) throw Error();
      const pid = +pids[0].slice(1); if (initial && initial !== pid) throw Error(); initial = pid;
      reason = "command_failure";
      const process = (await command(run, ["ps", "-p", String(pid), "-o", "comm="])).trim();
      reason = "process_unreadable"; if (process.split("/").pop() !== name) throw Error();
      reason = "command_failure"; const labels = await command(run, ["launchctl", "list"]);
      reason = "parse_failure"; parseStep = "launchctl_list"; const ignored = sidecars(labels);
      reason = "command_failure"; const net = await command(run, ["nettop", "-p", String(pid), "-L", "1", "-x", "-n", "-J", "bytes_in,bytes_out"]);
      reason = "parse_failure"; parseStep = "nettop"; const points: Point[] = parseNettop(net, pid, name, port).map(c => ({ ...c, ignored: false })); samples.push(points);
      if (points.length) {
        reason = "command_failure"; const sockets = await command(run, ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fpn"]);
        reason = "parse_failure"; parseStep = "lsof_established"; const attribution = owners(sockets, pid, port);
        for (const c of points) { const owner = attribution.get(c.peer); if (!owner) { unattributed.add(c.key); continue; } c.ignored = ignored.has(owner); }
      }
      reason = "command_failure"; if (i < count - 1) await sleep(window * 1000 / (count - 1));
    }
    return { ...idle(samples), unattributed: unattributed.size };
  } catch (error) { return { ...idle(samples), verdict: "busy_unknown", reason, commandError: failure(error), unattributed: unattributed.size, ...(reason === "parse_failure" ? { parseStep } : {}) }; }
}
export async function check(run: Runner, sleep: (ms: number) => Promise<unknown>, window: number, count: number, refresh: boolean) {
  let version: ReturnType<typeof versions> | undefined;
  let refreshStatus = refresh ? "ok" : "skipped", refreshError, versionError; const timings: Timing[] = [];
  if (refresh) try { await retried(run, ["brew", "update"], [120000], undefined, Date.now, timings); } catch (error) { refreshStatus = "failed"; refreshError = failure(error); }
  try { version = versions(await retried(run, ["brew", "info", "--json=v2", "cliproxyapi"], READ_LIMITS, undefined, Date.now, timings)); } catch (error) { versionError = failure(error); }
  const activity = await observe(run, sleep, window, count);
  const decision = !version ? "busy_unknown" : activity.verdict === "busy_unknown" ? "busy_unknown" : !version.newer ? "up_to_date" : activity.verdict === "busy" ? "busy" : "would_upgrade";
  return { refresh: refreshStatus, refreshError, versionError, checkedAt: new Date().toISOString(), installed: version?.installed ?? null, available: version?.available ?? null, decision, idle: activity, reason: !version ? "version_unreadable" : decision === "up_to_date" ? "installed_not_older" : activity.reason, blindSpots, timings };
}
