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

export type LocalClickHouseOptions = {
  queryLog?: boolean;
  keepFreeSpaceBytes?: number;
  /** Runs on the fresh server before it is handed over (e.g. applySchema); a failure stops the server and throws. */
  prepare?: (client: ClickHouse) => Promise<unknown>;
};

/**
 * Test-only pre-warming (tests/preload.ts turns it on). Once a set of options has been asked for twice,
 * up to `depth` servers with those options are started in the background for the next caller. Every
 * caller still gets its own fresh server process and data directory; only the start (and `prepare`)
 * overlaps earlier work. Spares are kept for the 3 most recently used option sets; older ones are stopped.
 * Off unless enabled, so production callers (src/archaeology/validation.ts) never leave a spare running.
 */
type Spare = { proc: ReturnType<typeof Bun.spawn>; dir: string; key: string; cancelled?: boolean };
const KEPT_OPTION_SETS = 3;
const prewarm = {
  depth: 0,
  asked: new Map<string, number>(),
  ready: new Map<string, Promise<LocalClickHouse>[]>(), // insertion order = least recently used first
  starting: new Set<Spare>(),
};
const prepareIds = new Map<NonNullable<LocalClickHouseOptions["prepare"]>, number>();
const prepareId = (prepare: LocalClickHouseOptions["prepare"]) => {
  if (!prepare) return 0;
  if (!prepareIds.has(prepare)) prepareIds.set(prepare, prepareIds.size + 1);
  return prepareIds.get(prepare)!;
};
const optionsKey = (options: LocalClickHouseOptions) =>
  `${options.queryLog === true}|${options.keepFreeSpaceBytes ?? 0}|${prepareId(options.prepare)}`;

let exitHooked = false;
/** Set the pre-warm depth (0 = off) and return the previous one. Spares are always stopped on exit. */
export function prewarmLocalClickHouse(depth: number): number {
  const previous = prewarm.depth;
  prewarm.depth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  if (prewarm.depth && !exitHooked) {
    exitHooked = true;
    process.on("exit", () => { stopPrewarmedLocalClickHouse(); });
    let terminating = false;
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      process.on(signal, () => {
        if (terminating) return;
        terminating = true;
        prewarm.depth = 0;
        // Exit remains bounded even if a child never acknowledges SIGKILL.
        const deadline = setTimeout(() => process.exit(code), 2000);
        void drainPrewarmedLocalClickHouse().catch(() => {}).finally(() => {
          clearTimeout(deadline);
          process.exit(code);
        });
      });
    }
  }
  return previous;
}

/**
 * Stop pre-warmed servers nobody took: one option set's, or all of them (which also forgets what was asked).
 * Synchronous, so it also runs on `exit`.
 */
export function stopPrewarmedLocalClickHouse(key?: string): number {
  const spares = [...prewarm.starting].filter(spare => key === undefined || spare.key === key);
  if (key === undefined) { prewarm.ready.clear(); prewarm.asked.clear(); } else prewarm.ready.delete(key);
  for (const spare of spares) {
    spare.cancelled = true;
    spare.proc.kill("SIGKILL");
  }
  for (const spare of spares) {
    // exit handlers cannot await proc.exited. SIGKILL delivery is asynchronous: wait for
    // OS exit evidence before unlinking, otherwise a starting server can recreate files.
    // A zombie is already inert; Bun reaps it when the runner resumes or exits.
    const deadline = Date.now() + 2000;
    while (spare.proc.exitCode === null) {
      const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(spare.proc.pid)]);
      if ((status.exitCode === 1 && !status.stdout.length && !status.stderr.length) || (status.exitCode === 0 && /^Z/.test(status.stdout.toString().trim()))) break;
      if (status.exitCode !== 0 || Date.now() >= deadline) throw Error("pre-warm child exit could not be confirmed");
      Bun.sleepSync(1);
    }
    rmSync(spare.dir, { recursive: true, force: true });
    prewarm.starting.delete(spare);
  }
  return spares.length;
}

/** Confirm owned children have exited before removing their directories (normal shutdown/eviction).
 * The synchronous stop above is only the best-effort process-exit fallback. SIGKILL of the
 * runner cannot be caught and requires a supervisor; no cleanup guarantee is made for it.
 */
export async function drainPrewarmedLocalClickHouse(key?: string): Promise<number> {
  const spares = [...prewarm.starting].filter(spare => key === undefined || spare.key === key);
  if (key === undefined) { prewarm.ready.clear(); prewarm.asked.clear(); } else prewarm.ready.delete(key);
  const results = await Promise.allSettled(spares.map(async spare => {
    spare.cancelled = true; // prevent a cancelled startup from spawning a replacement
    spare.proc.kill("SIGKILL");
    await spare.proc.exited;
    prewarm.starting.delete(spare);
    rmSync(spare.dir, { recursive: true, force: true });
  }));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(r => r.reason), "pre-warm shutdown failed");
  return spares.length;
}

/** Start a throwaway `clickhouse server` on free ports under .local/ (gitignored). */
export async function startLocalClickHouse(options: LocalClickHouseOptions = {}, allocatePorts = freePorts): Promise<LocalClickHouse> {
  const cold = () => spawnPrepared(options, allocatePorts);
  // A caller with its own port allocator is testing the start itself; it always gets a cold start.
  if (prewarm.depth === 0 || allocatePorts !== freePorts) return cold();
  const key = optionsKey(options);
  const asked = (prewarm.asked.get(key) ?? 0) + 1;
  prewarm.asked.set(key, asked);
  const queue = prewarm.ready.get(key) ?? [];
  const spare = queue.shift();
  if (asked >= 2) {
    prewarm.ready.delete(key);
    prewarm.ready.set(key, queue); // most recently used
    for (const old of [...prewarm.ready.keys()].slice(0, -KEPT_OPTION_SETS)) await drainPrewarmedLocalClickHouse(old);
    while (queue.length < prewarm.depth) {
      const next = spawnPrepared(options, freePorts, key);
      next.catch(() => {}); // a spare that fails to start is replaced by a cold start when taken
      queue.push(next);
    }
  }
  if (!spare) return cold();
  return spare.then(local => {
    // A taken spare is the caller's own server now: stopPrewarmedLocalClickHouse no longer touches it.
    const taken = spareOf.get(local)!;
    prewarm.starting.delete(taken);
    if (taken.proc.exitCode === null) return local;
    rmSync(taken.dir, { recursive: true, force: true });
    return cold();
  }, cold);
}

const spareOf = new WeakMap<LocalClickHouse, Spare>();

async function spawnPrepared(options: LocalClickHouseOptions, allocatePorts: typeof freePorts, spareKey?: string): Promise<LocalClickHouse> {
  const local = await spawnLocalClickHouse(options, allocatePorts, spareKey);
  if (!options.prepare) return local;
  try {
    await options.prepare(local.client);
  } catch (error) {
    const spare = spareOf.get(local);
    if (spare) prewarm.starting.delete(spare);
    await local.stop();
    throw error;
  }
  return local;
}

async function spawnLocalClickHouse(options: LocalClickHouseOptions, allocatePorts: typeof freePorts, spareKey?: string): Promise<LocalClickHouse> {
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
        `--storage_configuration.disks.default.keep_free_space_bytes=${options.keepFreeSpaceBytes ?? 0}`,
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
    const spare: Spare | null = spareKey === undefined ? null : { proc, dir, key: spareKey };
    if (spare) prewarm.starting.add(spare);
    const url = `http://127.0.0.1:${http}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      // A different server can answer on a port claimed between allocation and spawn.
      if (proc.exitCode !== null || Date.now() > deadline) {
        const exitedEarly = proc.exitCode !== null;
        proc.kill("SIGKILL");
        await proc.exited;
        if (spare && (spare.cancelled || !prewarm.starting.delete(spare))) throw new Error("pre-warmed local clickhouse was stopped before use");
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
        if (ready && res.ok && proc.exitCode === null) {
          const local: LocalClickHouse = {
            client: new ClickHouse({ url, user: "default", password: "", database: "tokenlayer" }),
            stop: async () => {
              proc.kill("SIGKILL");
              await proc.exited;
              rmSync(dir, { recursive: true, force: true });
            },
          };
          if (spare) spareOf.set(local, spare);
          return local;
        }
      } catch {}
      await Bun.sleep(200);
    }
  }
}
