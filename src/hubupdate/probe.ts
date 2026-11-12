import { spawnSync } from "node:child_process";
import { blindSpots, idle, owners, parseNettop, sidecars, versions, type Idle, type Point } from "./core";
export type Runner = (args: string[], timeout?: number) => Promise<string>;
export const runner: Runner = async ([command, ...args], timeout = 15000) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } });
  if (r.error || r.status !== 0) throw r.error ?? Error("command_failure"); return r.stdout;
};
class CommandError extends Error {
  constructor(readonly step: string, readonly kind: "timed_out" | "nonzero") { super("command_failure"); }
}
async function command(run: Runner, args: string[], timeout = 15000) {
  const step = args[0] === "brew" ? `brew_${args[1]}` : args[0] === "lsof" ? (args.includes("-sTCP:LISTEN") ? "lsof_listen" : "lsof_established") : args[0] === "launchctl" ? "launchctl_list" : args[0];
  try { return await run(args, timeout); }
  catch (error) { throw new CommandError(step, (error as { code?: string })?.code === "ETIMEDOUT" ? "timed_out" : "nonzero"); }
}
const failure = (error: unknown) => error instanceof CommandError ? { step: error.step, kind: error.kind } : undefined;
export async function observe(run: Runner, sleep: (ms: number) => Promise<unknown>, window: number, count: number): Promise<Idle & { commandError?: ReturnType<typeof failure> }> {
  const samples: Point[][] = [], unattributed = new Set<string>(); let initial = 0, reason = "command_failure";
  try {
    for (let i = 0; i < count; i++) {
      const pids = (await command(run, ["lsof", "-nP", "-iTCP:8317", "-sTCP:LISTEN", "-Fp"])).match(/^p\d+$/gm);
      reason = "pid_unreadable"; if (pids?.length !== 1) throw Error();
      const pid = +pids[0].slice(1); if (initial && initial !== pid) throw Error(); initial = pid;
      reason = "command_failure";
      const process = (await command(run, ["ps", "-p", String(pid), "-o", "comm="])).trim();
      reason = "process_unreadable"; if (process.split("/").pop() !== "cliproxyapi") throw Error();
      reason = "command_failure"; const labels = await command(run, ["launchctl", "list"]);
      reason = "parse_failure"; const ignored = sidecars(labels);
      reason = "command_failure"; const net = await command(run, ["nettop", "-p", String(pid), "-L", "1", "-x", "-n", "-J", "bytes_in,bytes_out"]);
      reason = "parse_failure"; const points: Point[] = parseNettop(net, pid).map(c => ({ ...c, ignored: false })); samples.push(points);
      if (points.length) {
        reason = "command_failure"; const sockets = await command(run, ["lsof", "-nP", "-iTCP:8317", "-sTCP:ESTABLISHED", "-Fpn"]);
        reason = "parse_failure"; const attribution = owners(sockets, pid);
        for (const c of points) { const owner = attribution.get(c.peer); if (!owner) { unattributed.add(c.key); continue; } c.ignored = ignored.has(owner); }
      }
      reason = "command_failure"; if (i < count - 1) await sleep(window * 1000 / (count - 1));
    }
    return { ...idle(samples), unattributed: unattributed.size };
  } catch (error) { return { ...idle(samples), verdict: "busy_unknown", reason, commandError: failure(error), unattributed: unattributed.size }; }
}
export async function check(run: Runner, sleep: (ms: number) => Promise<unknown>, window: number, count: number, refresh: boolean) {
  let version: ReturnType<typeof versions> | undefined;
  let refreshStatus = refresh ? "ok" : "skipped", refreshError, versionError;
  if (refresh) try { await command(run, ["brew", "update"], 120000); } catch (error) { refreshStatus = "failed"; refreshError = failure(error); }
  try { version = versions(await command(run, ["brew", "info", "--json=v2", "cliproxyapi"])); } catch (error) { versionError = failure(error); }
  const activity = await observe(run, sleep, window, count);
  const decision = !version ? "busy_unknown" : activity.verdict === "busy_unknown" ? "busy_unknown" : !version.newer ? "up_to_date" : activity.verdict === "busy" ? "busy" : "would_upgrade";
  return { refresh: refreshStatus, refreshError, versionError, checkedAt: new Date().toISOString(), installed: version?.installed ?? null, available: version?.available ?? null, decision, idle: activity, reason: !version ? "version_unreadable" : decision === "up_to_date" ? "installed_not_older" : activity.reason, blindSpots };
}
