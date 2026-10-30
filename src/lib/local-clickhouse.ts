import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClickHouse } from "./clickhouse";

/** Path to a local clickhouse binary, or null (integration tests then skip). Never the M1. */
export function clickhouseBinary(): string | null {
  if (process.env.TOKENLAYER_SKIP_IT === "1") return null;
  return Bun.which("clickhouse");
}

export type LocalClickHouse = { client: ClickHouse; stop: () => Promise<void> };

function freePorts() {
  const http = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try { return { http: http.port, tcp: tcp.port }; }
    finally { tcp.stop(true); }
  } finally { http.stop(true); }
}

/** Start a throwaway `clickhouse server` on free ports under .local/ (gitignored). */
export async function startLocalClickHouse(options: { queryLog?: boolean } = {}, allocatePorts = freePorts): Promise<LocalClickHouse> {
  const bin = clickhouseBinary();
  if (!bin) throw new Error("clickhouse binary not found");
  const root = join(import.meta.dir, "..", "..", ".local");
  mkdirSync(root, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const dir = mkdtempSync(join(root, "ch-it-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    const { http, tcp } = allocatePorts();
    if (options.queryLog) writeFileSync(join(dir, 'config.xml'), `<clickhouse>
      <profiles><default/></profiles>
      <users><default><password/><networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota></default></users>
      <quotas><default/></quotas>
      <query_log><database>system</database><table>query_log</table><flush_interval_milliseconds>1000</flush_interval_milliseconds></query_log>
    </clickhouse>`);
    const proc = Bun.spawn(
      [
        bin,
        "server",
        ...(options.queryLog ? [`--config-file=${join(dir, 'config.xml')}`] : []),
        "--",
        `--http_port=${http}`,
        `--tcp_port=${tcp}`,
        "--listen_host=127.0.0.1",
        `--path=${join(dir, "data")}/`,
        `--logger.log=${join(dir, "server.log")}`,
        `--logger.errorlog=${join(dir, "server.err.log")}`,
        "--logger.console=0",
        "--logger.async=0",
        "--mysql_port=0",
        "--postgresql_port=0",
        "--interserver_http_port=0",
      ],
      { cwd: dir, stdout: "ignore", stderr: "ignore", env: { ...process.env, CLICKHOUSE_WATCHDOG_ENABLE: "0" } },
    );
    const url = `http://127.0.0.1:${http}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      // A different server can answer on a port claimed between allocation and spawn.
      if (proc.exitCode !== null || Date.now() > deadline) {
        const exitedEarly = proc.exitCode !== null;
        proc.kill("SIGKILL");
        await proc.exited;
        if (exitedEarly && attempt < 3) break;
        let tail = "server.err.log unavailable";
        try {
          const lines = readFileSync(join(dir, "server.err.log"), "utf8").trimEnd().split("\n");
          tail = lines.slice(-20).join("\n");
          const lastError = lines.filter(line => /<(Error|Fatal)>/.test(line)).pop();
          if (lastError && !tail.includes(lastError)) tail = `${lastError}\n${tail}`;
        } catch {}
        throw new Error(`local clickhouse did not start after ${attempt} attempt(s) (logs in ${dir})\n${tail}`);
      }
      try {
        const ready = readFileSync(join(dir, "server.log"), "utf8").includes("Application: Ready for connections.");
        const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) });
        if (ready && res.ok && proc.exitCode === null) return {
          client: new ClickHouse({ url, user: "default", password: "", database: "tokenlayer" }),
          stop: async () => {
            proc.kill("SIGKILL");
            await proc.exited;
            rmSync(dir, { recursive: true, force: true });
          },
        };
      } catch {}
      await Bun.sleep(200);
    }
  }
}
