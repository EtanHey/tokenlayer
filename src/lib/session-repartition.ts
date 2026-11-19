import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixed, type ClickHouse } from "./clickhouse";
import { SESSION_RETENTION_DAYS } from "./session-retention";
import { SCHEMA_DIR } from "./schema";

/**
 * R12: move a monthly-partitioned tokenlayer.session_events to the daily layout of schema/004.
 *
 * A monthly partition mixes 30 days that expire one by one, so the row TTL either rewrites a whole part every
 * merge_with_ttl_timeout or, for a part over the 1 GiB merge cap, never deletes its expired rows. ClickHouse cannot
 * change a partition key in place, nor attach a monthly partition into daily ones, so this copies the rows.
 *
 * Order, all resumable from what the database shows:
 *   1. Create session_events_daily_next from schema/004 with migration 011's TTL, then EXCHANGE it with the live table
 *      and rename the old one to session_events_monthly. Shippers keep inserting; from here they write daily parts.
 *   2. For each archive partition, smallest first, while free disk minus the partition's bytes stays above the floor:
 *      INSERT the kept rows (FINAL: one version per key; expired rows skipped), check every kept key arrived, then
 *      DROP that archive partition. Until a partition is copied, views do not show its rows.
 *   3. Drop the archive once it holds no parts.
 */

const LIVE = "tokenlayer.session_events";
const NEXT = "tokenlayer.session_events_daily_next";
const ARCHIVE = "tokenlayer.session_events_monthly";
const KEY = "sipHash128(machine, path, generation, byte_offset, content_hash)";
const GiB = 1024 ** 3;
/**
 * A session line averages about 5.5 KB. With default blocks (65k rows per read thread, 256 MiB insert squashing) a
 * local copy of 464 MiB peaked at 4.85 GiB of memory (the hub login caps a query at 8 GiB); these bounds held it to
 * 884 MiB at about 0.6x the time of OPTIMIZE FINAL on the same parts (receipt R12). Dedup tokens
 * stay off so the copy does not fill the shippers' insert-dedup window.
 */
const COPY_SETTINGS = "do_not_merge_across_partitions_select_final = 1, max_partitions_per_insert_block = 0, insert_deduplicate = 0, " +
  "max_threads = 2, max_insert_threads = 1, max_block_size = 4096, min_insert_block_size_rows = 65536, min_insert_block_size_bytes = 33554432";

export type PartitionPlan = { partition: string; bytes: number; rows: number };
export type CopiedPartition = PartitionPlan & { kept: number; seconds: number };
export type RepartitionReport = {
  state: "dry-run" | "already-daily" | "partial" | "done";
  freeBytes: number;
  floorBytes: number;
  copied: CopiedPartition[];
  remaining: PartitionPlan[];
};
export type RepartitionOptions = {
  /** Free disk that must remain after a partition's copy lands. Default 30 GiB (the M1's floor). */
  floorBytes?: number;
  /** Stop after this many partitions; a rerun resumes. */
  maxPartitions?: number;
  /** Report the plan only. */
  dryRun?: boolean;
  /** How long to wait for a dropped partition's disk to come back before the next one. Default 600 s. */
  settleMs?: number;
  log?: (line: string) => void;
};

/** Rows migration 011's TTL keeps at the SQL time `at`: Antigravity, January 1970, and rows inside the window. */
export function keptRowsSQL(at: string): string {
  return `(harness = 'antigravity' OR toYYYYMM(ts) = 197001 OR toDateTime(ts) + INTERVAL ${SESSION_RETENTION_DAYS} DAY > ${at})`;
}

/** Disk free as `df` reports it: ClickHouse's free_space excludes keep_free_space_bytes. */
async function freeBytes(ch: ClickHouse): Promise<number> {
  const [d] = await ch.queryJSON<{ free: string }>("SELECT toString(free_space + keep_free_space) AS free FROM system.disks WHERE name = 'default'");
  return Number(d?.free ?? 0);
}

async function tableKeys(ch: ClickHouse): Promise<Map<string, string>> {
  const rows = await ch.queryJSON<{ name: string; partition_key: string }>(
    "SELECT name, partition_key FROM system.tables WHERE database = 'tokenlayer' AND name IN ('session_events', 'session_events_daily_next', 'session_events_monthly')");
  return new Map(rows.map(r => [r.name, r.partition_key]));
}

async function partitions(ch: ClickHouse, table: string): Promise<PartitionPlan[]> {
  const rows = await ch.queryJSON<{ partition: string; bytes: string; rows: string }>(
    `SELECT partition_id AS partition, toString(sum(bytes_on_disk)) AS bytes, toString(sum(rows)) AS rows FROM system.parts
     WHERE database = 'tokenlayer' AND table = '${table}' AND active GROUP BY partition_id ORDER BY sum(bytes_on_disk), partition_id`);
  return rows.map(r => ({ partition: r.partition, bytes: Number(r.bytes), rows: Number(r.rows) }));
}

/** Migration 011's session_events statements (settings, then TTL), aimed at `table`. */
function retentionStatements(table: string): string[] {
  return readFileSync(join(SCHEMA_DIR, "011_session_retention.sql"), "utf8")
    .replaceAll("{{SESSION_RETENTION_DAYS}}", String(SESSION_RETENTION_DAYS))
    .split("\n").filter(l => !l.trim().startsWith("--")).join("\n")
    .split(";").map(s => s.trim()).filter(s => s.startsWith(`ALTER TABLE ${LIVE} `))
    .map(s => s.replace(`ALTER TABLE ${LIVE} `, `ALTER TABLE ${table} `));
}

async function storedColumns(ch: ClickHouse): Promise<string[]> {
  const cols = await ch.queryJSON<{ name: string }>(
    `SELECT name FROM system.columns WHERE database = 'tokenlayer' AND table = 'session_events_monthly' AND default_kind != 'MATERIALIZED'
     AND name IN (SELECT name FROM system.columns WHERE database = 'tokenlayer' AND table = 'session_events' AND default_kind != 'MATERIALIZED')
     ORDER BY position`);
  return cols.map(c => `\`${c.name.replaceAll("`", "``")}\``);
}

async function utcNow(ch: ClickHouse): Promise<string> {
  return (await ch.exec("SELECT toString(now('UTC'))")).trim();
}

export async function repartitionSessionEvents(ch: ClickHouse, options: RepartitionOptions = {}): Promise<RepartitionReport> {
  fixed(ch, "session_events");
  const floorBytes = options.floorBytes ?? 30 * GiB;
  const settleMs = options.settleMs ?? 600_000;
  const log = options.log ?? (() => {});
  const copied: CopiedPartition[] = [];
  let keys = await tableKeys(ch);
  const liveKey = keys.get("session_events");
  if (!liveKey) throw new Error("tokenlayer.session_events does not exist");
  const monthly = (k?: string) => k === "toYYYYMM(ts)";
  const daily = (k?: string) => k === "toYYYYMMDD(ts)";
  if (!monthly(liveKey) && !daily(liveKey)) throw new Error(`unexpected session_events partition key ${liveKey}`);

  // Step 1 (or its crash leftovers).
  if (monthly(liveKey)) {
    const plan = await partitions(ch, "session_events");
    const free = await freeBytes(ch);
    if (options.dryRun) return { state: "dry-run", freeBytes: free, floorBytes, copied, remaining: plan };
    if (keys.has("session_events_monthly")) throw new Error("session_events is monthly but session_events_monthly exists; inspect before retrying");
    const first = plan[0];
    if (first && free - first.bytes < floorBytes) {
      throw new Error(`disk floor: free ${(free / GiB).toFixed(2)} GiB minus partition ${first.partition} (${(first.bytes / GiB).toFixed(2)} GiB) is under ${(floorBytes / GiB).toFixed(2)} GiB; nothing changed`);
    }
    if (keys.has("session_events_daily_next")) {
      if (!daily(keys.get("session_events_daily_next"))) throw new Error("session_events_daily_next is not daily; inspect before retrying");
      const n = (await ch.exec(`SELECT count() FROM ${NEXT}`)).trim();
      if (n !== "0") throw new Error(`session_events_daily_next already holds ${n} rows; inspect before retrying`);
    } else {
      const ddl = readFileSync(join(SCHEMA_DIR, "004_session_events.sql"), "utf8");
      await ch.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${LIVE}`, `CREATE TABLE ${NEXT}`).replace(/;\s*$/, ""));
    }
    for (const statement of retentionStatements(NEXT)) await ch.exec(statement);
    await ch.exec(`EXCHANGE TABLES ${LIVE} AND ${NEXT}`);
    log(`exchanged: ${LIVE} is daily; the monthly table is ${NEXT}`);
    keys = await tableKeys(ch);
  }
  if (monthly(keys.get("session_events_daily_next"))) {
    await ch.exec(`RENAME TABLE ${NEXT} TO ${ARCHIVE}`);
    keys = await tableKeys(ch);
  }
  if (keys.has("session_events_daily_next")) throw new Error("session_events_daily_next left over next to a daily session_events; inspect before retrying");
  if (!keys.has("session_events_monthly")) {
    return { state: "already-daily", freeBytes: await freeBytes(ch), floorBytes, copied, remaining: [] };
  }
  if (!monthly(keys.get("session_events_monthly"))) throw new Error("session_events_monthly is not monthly; inspect before retrying");
  // The archive's own TTL and merges would only rewrite parts that are about to be copied and dropped.
  await ch.exec(`SYSTEM STOP MERGES ${ARCHIVE}`);

  // Step 2.
  let remaining = await partitions(ch, "session_events_monthly");
  if (options.dryRun) return { state: "dry-run", freeBytes: await freeBytes(ch), floorBytes, copied, remaining };
  const columns = (await storedColumns(ch)).join(", ");
  while (remaining.length) {
    if (options.maxPartitions !== undefined && copied.length >= options.maxPartitions) break;
    const p = remaining[0];
    if (!/^\d{6}$/.test(p.partition)) throw new Error(`unexpected archive partition id ${p.partition}`);
    // A dropped partition's files go after old_parts_lifetime; wait for them rather than refuse at once.
    let free = await freeBytes(ch);
    for (const deadline = Date.now() + settleMs; free - p.bytes < floorBytes && Date.now() < deadline; free = await freeBytes(ch)) {
      await Bun.sleep(Math.min(10_000, settleMs));
    }
    if (free - p.bytes < floorBytes) {
      log(`stop: free ${(free / GiB).toFixed(2)} GiB minus ${p.partition} (${(p.bytes / GiB).toFixed(2)} GiB) is under the ${(floorBytes / GiB).toFixed(2)} GiB floor`);
      break;
    }
    const started = Date.now();
    const cutoff = `toDateTime('${await utcNow(ch)}', 'UTC')`;
    const source = `FROM ${ARCHIVE} FINAL WHERE _partition_id = '${p.partition}' AND ${keptRowsSQL(cutoff)}`;
    await ch.exec(`INSERT INTO ${LIVE} (${columns}) SELECT ${columns} ${source}
      SETTINGS ${COPY_SETTINGS}`);
    // Every kept key must be in the live table before its archive partition goes. A day that expires completely
    // between the copy and this check may already be dropped by the live TTL, so the check leaves out the next hour.
    const [check] = await ch.queryJSON<{ kept: string; missing: string }>(`
      SELECT toString(count()) AS kept, toString(countIf(k NOT IN (SELECT ${KEY} FROM ${LIVE} WHERE toYYYYMM(ts) = ${p.partition}))) AS missing
      FROM (SELECT ${KEY} AS k ${source} AND ${keptRowsSQL(`(${cutoff} + INTERVAL 1 HOUR)`)})
      SETTINGS do_not_merge_across_partitions_select_final = 1`);
    if (!check || check.missing !== "0") throw new Error(`partition ${p.partition}: ${check?.missing ?? "?"} kept keys missing after the copy; the archive partition is kept`);
    await ch.exec(`ALTER TABLE ${ARCHIVE} DROP PARTITION ID '${p.partition}'`);
    const done = { ...p, kept: Number(check.kept), seconds: (Date.now() - started) / 1000 };
    copied.push(done);
    log(`copied ${p.partition}: ${p.rows} rows (${(p.bytes / GiB).toFixed(2)} GiB) → ${done.kept} kept in ${done.seconds.toFixed(1)} s`);
    remaining = await partitions(ch, "session_events_monthly");
  }

  // Step 3.
  if (remaining.length) return { state: "partial", freeBytes: await freeBytes(ch), floorBytes, copied, remaining };
  if ((await ch.exec(`SELECT count() FROM ${ARCHIVE}`)).trim() !== "0") throw new Error("session_events_monthly has no active parts but still counts rows; inspect");
  await ch.exec(`DROP TABLE ${ARCHIVE} SYNC`);
  log("done: the monthly archive is empty and dropped");
  return { state: "done", freeBytes: await freeBytes(ch), floorBytes, copied, remaining };
}

if (import.meta.main) {
  const { installErrorHandlers, writeOut } = await import("./egress");
  installErrorHandlers();
  const { ClickHouse } = await import("./clickhouse");
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const floorGiB = flag("--floor-gib");
  const maxPartitions = flag("--max-partitions");
  const report = await repartitionSessionEvents(ClickHouse.fromEnv(), {
    dryRun: args.includes("--dry-run"),
    floorBytes: floorGiB === undefined ? undefined : Number(floorGiB) * GiB,
    maxPartitions: maxPartitions === undefined ? undefined : Number(maxPartitions),
    log: line => writeOut(line),
  });
  writeOut(JSON.stringify(report));
}
