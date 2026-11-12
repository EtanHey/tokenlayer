import { spawnSync } from "node:child_process";
import { blindSpots, idle, owners, parseNettop, sidecars, versions, type Idle, type Point } from "./core";
export type Runner = (args: string[]) => Promise<string>;
export const runner: Runner = async ([command, ...args]) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } });
  if (r.error || r.status !== 0) throw Error("command_failure"); return r.stdout;
};
export async function observe(run: Runner, sleep: (ms: number) => Promise<unknown>, window: number, count: number): Promise<Idle> {
  const samples: Point[][] = [], unknown = new Set<string>(); let initial = 0, reason = "command_failure";
  try {
    for (let i = 0; i < count; i++) {
      const pids = (await run(["lsof", "-nP", "-iTCP:8317", "-sTCP:LISTEN", "-Fp"])).match(/^p\d+$/gm);
      reason = "pid_unreadable"; if (pids?.length !== 1) throw Error();
      const pid = +pids[0].slice(1); if (initial && initial !== pid) throw Error(); initial = pid;
      reason = "command_failure";
      const process = (await run(["ps", "-p", String(pid), "-o", "comm="])).trim();
      reason = "process_unreadable"; if (process.split("/").pop() !== "cliproxyapi") throw Error();
      reason = "command_failure"; const labels = await run(["launchctl", "list"]);
      reason = "parse_failure"; const ignored = sidecars(labels);
      reason = "command_failure"; const net = await run(["nettop", "-p", String(pid), "-L", "1", "-x", "-n", "-J", "bytes_in,bytes_out"]);
      reason = "parse_failure"; const points: Point[] = parseNettop(net, pid).map(c => ({ ...c, ignored: false })); samples.push(points);
      if (points.length) {
        reason = "command_failure"; const sockets = await run(["lsof", "-nP", "-iTCP:8317", "-sTCP:ESTABLISHED", "-Fpn"]);
        reason = "parse_failure"; const attribution = owners(sockets, pid);
        reason = "unattributed_client";
        for (const c of points) { const owner = attribution.get(c.peer); if (!owner) { unknown.add(c.key); continue; } c.ignored = ignored.has(owner); c.owner = owner; }
      }
      reason = "command_failure"; if (i < count - 1) await sleep(window * 1000 / (count - 1));
    }
    return unknown.size ? { ...idle(samples), verdict: "busy_unknown", reason: "unattributed_client", unattributed: unknown.size } : idle(samples);
  } catch { return { ...idle(samples), verdict: "busy_unknown", reason, unattributed: unknown.size }; }
}
export async function check(run: Runner, sleep: (ms: number) => Promise<unknown>, window: number, count: number, refresh: boolean) {
  let version: ReturnType<typeof versions> | undefined;
  try { if (refresh) await run(["brew", "update"]); version = versions(await run(["brew", "info", "--json=v2", "cliproxyapi"])); } catch { /* Still collect idle measurements. */ }
  const activity = await observe(run, sleep, window, count);
  const decision = !version ? "busy_unknown" : activity.verdict === "busy_unknown" ? "busy_unknown" : !version.newer ? "up_to_date" : activity.verdict === "busy" ? "busy" : "would_upgrade";
  return { checkedAt: new Date().toISOString(), installed: version?.installed ?? null, available: version?.available ?? null, decision, idle: activity, reason: !version ? "version_unreadable" : decision === "up_to_date" ? "installed_not_older" : activity.reason, blindSpots };
}
