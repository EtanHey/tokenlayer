import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ClickHouse } from "./clickhouse";

/** Path to a local clickhouse binary, or null (integration tests then skip). Never the M1. */
export function clickhouseBinary(): string | null {
  if (process.env.TOKENLAYER_SKIP_IT === "1") return null;
  return Bun.which("clickhouse");
}

export type LocalClickHouse = { client: ClickHouse; stop: () => Promise<void> };

/** Start a throwaway `clickhouse server` on random ports under .local/ (gitignored). */
export async function startLocalClickHouse(): Promise<LocalClickHouse> {
  const bin = clickhouseBinary();
  if (!bin) throw new Error("clickhouse binary not found");
  const root = join(import.meta.dir, "..", "..", ".local");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "ch-it-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const http = 20000 + Math.floor(Math.random() * 20000);
  const tcp = http + 1;
  const proc = Bun.spawn(
    [
      bin,
      "server",
      "--",
      `--http_port=${http}`,
      `--tcp_port=${tcp}`,
      "--listen_host=127.0.0.1",
      `--path=${join(dir, "data")}/`,
      `--logger.log=${join(dir, "server.log")}`,
      `--logger.errorlog=${join(dir, "server.err.log")}`,
      "--logger.console=0",
      "--mysql_port=0",
      "--postgresql_port=0",
      "--interserver_http_port=0",
    ],
    { cwd: dir, stdout: "ignore", stderr: "ignore", env: { ...process.env, CLICKHOUSE_WATCHDOG_ENABLE: "0" } },
  );
  const url = `http://127.0.0.1:${http}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/ping`);
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline || proc.exitCode !== null) {
      proc.kill();
      throw new Error(`local clickhouse did not start (logs in ${dir})`);
    }
    await Bun.sleep(200);
  }
  return {
    client: new ClickHouse({ url, user: "default", password: "", database: "tokenlayer" }),
    stop: async () => {
      proc.kill("SIGKILL");
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
