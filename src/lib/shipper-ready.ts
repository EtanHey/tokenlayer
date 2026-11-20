/**
 * R12 preflight (S9): once session_events is daily, a ship insert spanning more than 100 UTC days fails with
 * exception 252 unless it sets max_partitions_per_insert_block = 0, which only the client from #199 on does
 * (src/lib/clickhouse.ts). A shipper still running older code would retry such a batch for ever and leave its file
 * stuck. So the swap waits until each Mac's running shipper loaded a client that sets it.
 *
 * Each Mac answers with what launchd runs (working directory, pid), how long that process has run, and whether the
 * checkout's clickhouse.ts sets the limit and when that file last changed. A process that started before the file
 * changed may still run the old code.
 */

/** The line the shipper's client must carry. */
export const SHIP_SETTING_LINE = `params.set("max_partitions_per_insert_block", "0")`;
/** The M4's ssh name from the M1 (as ratchet/usage-age.ts uses it). */
export const M4_HOST = "macbook-pro";

export const SHIPPER_PROBE = [
  `p=$(launchctl print "gui/$(id -u)/com.tokenlayer.ship" 2>/dev/null)`,
  `dir=$(printf '%s\\n' "$p" | sed -n 's/^[[:space:]]*working directory = //p' | head -1)`,
  `pid=$(printf '%s\\n' "$p" | sed -n 's/^[[:space:]]*pid = //p' | head -1)`,
  `printf 'dir %s\\npid %s\\n' "$dir" "$pid"`,
  `[ -n "$pid" ] && printf 'etime %s\\n' "$(ps -o etime= -p "$pid" | tr -d ' ')"`,
  `[ -n "$dir" ] && printf 'mtime %s\\nhas %s\\n' "$(stat -f %m "$dir/src/lib/clickhouse.ts" 2>/dev/null)" "$(grep -cF '${SHIP_SETTING_LINE}' "$dir/src/lib/clickhouse.ts" 2>/dev/null)"`,
  `printf 'now %s\\n' "$(date +%s)"`,
].join("; ");

export type ShipperProbe = { exitCode: number | null; stdout: string; stderr: string };

/** ps etime, `[[dd-]hh:]mm:ss`, in seconds; NaN when it is not that. */
export function etimeSeconds(etime: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return NaN;
  const [, d = "0", h = "0", min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** Why `machine`'s shipper is not ready for daily partitions; undefined when it is. */
export function shipperProblem(machine: string, probe: ShipperProbe): string | undefined {
  if (probe.exitCode !== 0) {
    return `${machine}: could not read its shipper (exit ${probe.exitCode}${probe.stderr.trim() ? `: ${probe.stderr.trim().split("\n")[0]}` : ""}); wake it and retry`;
  }
  const field = (name: string) => new RegExp(`^${name} (.*)$`, "m").exec(probe.stdout)?.[1]?.trim() ?? "";
  const dir = field("dir");
  if (!dir) return `${machine}: com.tokenlayer.ship is not loaded in launchd, so what it will run is unknown`;
  if (field("has") !== "1") return `${machine}: ${dir}/src/lib/clickhouse.ts does not set max_partitions_per_insert_block = 0; update that checkout to #199's code`;
  const pid = field("pid");
  if (!pid) return undefined; // not running now; it loads the updated checkout when it starts
  const now = Number(field("now")), mtime = Number(field("mtime")), ran = etimeSeconds(field("etime"));
  if (!Number.isFinite(now) || !Number.isFinite(mtime) || !Number.isFinite(ran) || !field("mtime") || !field("now")) {
    return `${machine}: could not tell when its shipper (pid ${pid}) started or when its client changed`;
  }
  if (now - ran <= mtime) {
    return `${machine}: its shipper (pid ${pid}) started before ${dir}/src/lib/clickhouse.ts last changed, so it may run the old client; ` +
      `restart it (launchctl kickstart -k gui/$(id -u)/com.tokenlayer.ship)`;
  }
  return undefined;
}

function run(argv: string[]): ShipperProbe {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 20_000 });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Problems with the M1's (this Mac's) and the M4's shippers; empty when both are ready. */
export async function shipperProblems(m4Host = process.env.TOKENLAYER_M4_HOST || M4_HOST): Promise<string[]> {
  const local = run(["/bin/sh", "-c", SHIPPER_PROBE]);
  const m4 = run(["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", m4Host, SHIPPER_PROBE]);
  return [shipperProblem("M1 (this Mac)", local), shipperProblem(`M4 (${m4Host})`, m4)].filter((p): p is string => !!p);
}
