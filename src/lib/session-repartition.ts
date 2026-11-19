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
 *   1. Refuse, changing nothing, unless both Macs' shippers run a client that can write more than 100 days in one
 *      insert (shipper-ready.ts), and free disk covers the floor and the watchdog's margin plus the most demanding
 *      part: COPY_GROWTH times the part (its copied days stay until it drops) plus DAY_AMPLIFICATION times its largest
 *      day. A day's size is its share of the part's bytes, by source-line bytes or rows, whichever is larger. Create
 *      session_events_daily_next from schema/004 with migration 011's TTL, then EXCHANGE it with the live table and
 *      rename the old one to session_events_monthly. Shippers keep inserting; from here they write daily parts.
 *   2. With the archive's merges stopped and the live table in WINDOW_SETTINGS, for each archive part, smallest
 *      first: find the days not yet in the live table at the same or a newer version (a rerun after a kill), and wait
 *      until free disk covers what those days need (step 1's test, on fresh runs and resumes alike). Then one day at a
 *      time: wait until free disk covers DAY_AMPLIFICATION times the day above the floor and margin, then INSERT the
 *      day's kept rows under their own query_id while a watchdog KILLs that query once free disk falls under the floor
 *      plus KILL_MARGIN (merges already running finish after a kill), or after FAILED_READS_TO_KILL failed reads, and
 *      checks the query is gone. Free disk is read before every day, so garbage from earlier days' merges is counted
 *      and waited out. Once every day is in, check every kept key of the part arrived, then DROP the part.
 *      Every version of a key is copied as it is and the TTL's per-row predicate applies, so the result equals what
 *      the monthly table would keep. Duplicate versions collapse as each day's parts merge (FINAL reads already do).
 *      Until a part is copied, views show only the days of it already copied.
 *   3. Drop the archive once it holds no parts.
 *
 * `dryRun` sends SELECTs only, in every state. An abort signal (Ctrl-C) kills the running copy on the server before
 * the call rejects; a copy left running by a killed client makes the next run refuse until it ends.
 */

const LIVE = "tokenlayer.session_events";
const NEXT = "tokenlayer.session_events_daily_next";
const ARCHIVE = "tokenlayer.session_events_monthly";
const KEY = "sipHash128(machine, path, generation, byte_offset, content_hash)";
const GiB = 1024 ** 3;
/** Every copy's query_id starts with this, so a run (or an operator) can find and kill copies on the server. */
export const COPY_QUERY_PREFIX = "r12-";
/**
 * Disk a day's copy takes at its peak, as a multiple of the day's share of the source part: the copied parts, the
 * live table's merges of them, and the merges' inputs until cleanup removes them. Free disk is read before every day,
 * so garbage left by earlier days is already counted, and the gate waits for cleanup when it is short.
 * Measured locally on ClickHouse 26.10 (receipt R12, round 1): 1.8-2.3x per day, higher for larger days; 3 leaves margin.
 */
export const DAY_AMPLIFICATION = 3;
/** Copied rows take a little more disk than the source part they came from (measured 1.05x); the gate uses 1.1. */
export const COPY_GROWTH = 1.1;
/**
 * The watchdog kills a copy this far above the floor, so the floor holds through what a kill cannot stop: merges of the
 * day's copied parts already running (each writes up to the 1 GiB merge cap) and a ship burst between two reads.
 */
export const KILL_MARGIN = 2 * GiB;
/** Consecutive failed free-disk reads after which the watchdog kills the copy: a server too stressed to answer is unsafe. */
export const FAILED_READS_TO_KILL = 3;
/** How long the watchdog keeps re-issuing KILL before it stops the run loudly, the copy perhaps still writing. */
export const KILL_CONFIRM_MS = 60_000;
/**
 * A session line averages about 5.5 KB. With default blocks (65k rows per read thread, 256 MiB insert squashing) a
 * local copy of 464 MiB peaked at 4.85 GiB of memory (the hub login caps a query at 8 GiB); these bounds held it to
 * 884 MiB at about 0.6x the time of OPTIMIZE FINAL on the same parts (receipt R12). Dedup tokens
 * stay off so the copy does not fill the shippers' insert-dedup window.
 */
const COPY_SETTINGS: Record<string, string | number> = {
  max_partitions_per_insert_block: 0, insert_deduplicate: 0, max_threads: 2, max_insert_threads: 1, max_block_size: 4096,
  min_insert_block_size_rows: 65536, min_insert_block_size_bytes: 33554432,
};
/**
 * Live-table settings for the copy window. A merge's inputs normally stay on disk for old_parts_lifetime (480 s) in
 * case a crash loses the unsynced merged part; during the copy that garbage was most of the disk peak. Here merged and
 * inserted parts are fsynced instead, so the inputs can go after 10 s, and no copied part can vanish in a power cut
 * after its archive part is dropped. Step 3 resets them.
 */
const WINDOW_SETTINGS = { old_parts_lifetime: 10, fsync_after_insert: 1, min_compressed_bytes_to_fsync_after_merge: 1 };
const RESET_WINDOW_SETTINGS = (table: string) => `ALTER TABLE ${table} RESET SETTING ${Object.keys(WINDOW_SETTINGS).join(", ")}`;
/** Where a back-out puts the daily table, so it cannot pass for the monthly archive this run always drops. */
export const BACKED_OUT = "tokenlayer.session_events_daily_backed_out";
/**
 * Runbook back-out: the monthly archive goes live again with the merges this run stopped on it restarted, and the
 * daily table is renamed to BACKED_OUT without its window settings. Stop the CLI first, and confirm no `r12-` query runs.
 * BACKED_OUT is then the only copy of the days already copied (their archive parts were dropped) and of every row
 * shipped during the window: copy it back day by day with copyBackSQL before dropping it.
 */
export const BACK_OUT_SQL = [
  `EXCHANGE TABLES ${LIVE} AND ${ARCHIVE}`, `RENAME TABLE ${ARCHIVE} TO ${BACKED_OUT}`, `SYSTEM START MERGES ${LIVE}`, RESET_WINDOW_SETTINGS(BACKED_OUT),
];
/** schema/004's stored columns (no MATERIALIZED, ALIAS or EPHEMERAL), in its order. */
export function storedColumns004(): string[] {
  const ddl = readFileSync(join(SCHEMA_DIR, "004_session_events.sql"), "utf8");
  const body = ddl.slice(ddl.indexOf("(\n") + 2, ddl.indexOf("\n    INDEX "));
  return body.split("\n").flatMap(l => {
    const m = /^ {4}(\w+)\s+\S/.exec(l);
    return m && !/\b(MATERIALIZED|ALIAS|EPHEMERAL)\b/.test(l) ? [m[1]] : [];
  });
}
/** Days the back-out copy-back still has to move, with their bytes on disk. */
export const COPY_BACK_DAYS_SQL = `SELECT partition_id AS day, toString(sum(bytes_on_disk)) AS bytes FROM system.parts
  WHERE database = 'tokenlayer' AND table = '${BACKED_OUT.split(".")[1]}' AND active GROUP BY day ORDER BY day`;
/**
 * The back-out copy-back of one UTC day (`day` as YYYYMMDD), run after BACK_OUT_SQL, in order:
 *   1. only when `df` free is at least the floor + KILL_MARGIN + DAY_AMPLIFICATION x the day's bytes (COPY_BACK_DAYS_SQL),
 *      INSERT the day into the restored live table (watch df meanwhile; KILL QUERY it if df nears the floor);
 *   2. a check that must read 0: keys of the day whose newest version the live table lacks;
 *   3. only then DROP the day from BACKED_OUT, which frees its disk before the next day.
 * Once COPY_BACK_DAYS_SQL is empty, DROP TABLE BACKED_OUT.
 */
export function copyBackSQL(day: string): { insert: string; check: string; drop: string } {
  if (!/^\d{8}$/.test(day)) throw new Error(`copy-back day must be YYYYMMDD, not ${day}`);
  const columns = storedColumns004().map(c => `\`${c}\``).join(", ");
  const settings = Object.entries(COPY_SETTINGS).map(([n, v]) => `${n} = ${v}`).join(", ");
  return {
    insert: `INSERT INTO ${LIVE} (${columns}) SELECT ${columns} FROM ${BACKED_OUT} WHERE toYYYYMMDD(ts) = ${day} SETTINGS ${settings}`,
    check: `SELECT countIf(l.at < a.at) FROM
      (SELECT ${KEY} AS k, max(ingested_at) AS at FROM ${BACKED_OUT} WHERE toYYYYMMDD(ts) = ${day} GROUP BY k) AS a
      LEFT JOIN (SELECT ${KEY} AS k, max(ingested_at) AS at FROM ${LIVE} WHERE toYYYYMMDD(ts) = ${day} GROUP BY k) AS l USING (k)
      SETTINGS join_use_nulls = 0, max_threads = 2`,
    drop: `ALTER TABLE ${BACKED_OUT} DROP PARTITION ${day}`,
  };
}

export type PartPlan = { partition: string; part: string; bytes: number; rows: number; maxDayBytes: number };
export type CopiedPart = PartPlan & { kept: number; days: number; skippedDays: number; seconds: number };
export type RepartitionReport = {
  state: "dry-run" | "already-daily" | "partial" | "done";
  freeBytes: number;
  floorBytes: number;
  /**
   * Free disk the most demanding remaining part needs to finish without the floor breaking: the floor and the
   * watchdog's margin, plus its copied days (COPY_GROWTH times the part, kept until the part drops), plus
   * DAY_AMPLIFICATION times its largest day.
   */
  needBytes: number;
  copied: CopiedPart[];
  remaining: PartPlan[];
  /** Why a partial run stopped early (disk, or an insert still writing to the archive). */
  stopped?: string;
  /** Dry run: what a real run would do next, and why it would refuse. */
  actions?: string[];
  refusal?: string;
};
export type RepartitionOptions = {
  /** Free disk that must remain throughout the copy. Default 30 GiB (the M1's floor). */
  floorBytes?: number;
  /** The watchdog kills a copy once free disk falls under floor + this. Default KILL_MARGIN. */
  killMarginBytes?: number;
  /** How long the watchdog keeps re-issuing KILL before the run stops loudly. Default KILL_CONFIRM_MS. */
  killConfirmMs?: number;
  /** Why the shippers are not ready for daily partitions (empty: ready). Checked before the swap. Default: shipper-ready.ts. */
  shipperCheck?: () => Promise<string[]>;
  /** Disk multiplier per copied day; default DAY_AMPLIFICATION. */
  amplification?: number;
  /** Stop after this many parts; a rerun resumes. */
  maxParts?: number;
  /** Report the plan only; sends SELECTs only. */
  dryRun?: boolean;
  /** How long to wait for free disk to come back before the next day. Default 600 s. */
  settleMs?: number;
  /** How often the watchdog reads free disk while a copy runs. Default 1 s. */
  watchMs?: number;
  /** Abort (Ctrl-C): kill the running copy on the server, then reject. */
  signal?: AbortSignal;
  /** Free disk in bytes; default system.disks (free_space + keep_free_space, as `df` shows it). Tests replace it. */
  freeBytes?: (ch: ClickHouse) => Promise<number>;
  /** Settings over the copy's own (tests slow the copy down to watch it). */
  extraCopySettings?: Record<string, string | number>;
  log?: (line: string) => void;
};

/** Rows migration 011's TTL keeps at the SQL time `at`: Antigravity, January 1970, and rows inside the window. */
export function keptRowsSQL(at: string): string {
  return `(harness = 'antigravity' OR toYYYYMM(ts) = 197001 OR toDateTime(ts) + INTERVAL ${SESSION_RETENTION_DAYS} DAY > ${at})`;
}

const gib = (b: number) => (b / GiB).toFixed(2);

/** Disk free as `df` reports it: ClickHouse's free_space excludes keep_free_space_bytes. */
async function diskFreeBytes(ch: ClickHouse): Promise<number> {
  const [d] = await ch.queryJSON<{ free: string }>("SELECT toString(free_space + keep_free_space) AS free FROM system.disks WHERE name = 'default'");
  return Number(d?.free ?? 0);
}

/** The dry run's client: anything but a SELECT throws before it reaches the server. */
function selectOnly(ch: ClickHouse): ClickHouse {
  const guard = (sql: string) => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error(`dry run refused to send a non-SELECT: ${sql.trim().slice(0, 60)}`);
  };
  return new Proxy(ch, {
    get(target, prop, receiver) {
      if (prop === "exec") return (sql: string, o?: { queryId?: string }) => { guard(sql); return target.exec(sql, o); };
      if (prop === "queryJSON") return (sql: string) => { guard(sql); return target.queryJSON(sql); };
      if (prop === "insert") return () => { throw new Error("dry run refused an insert"); };
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function tableKeys(ch: ClickHouse): Promise<Map<string, string>> {
  const rows = await ch.queryJSON<{ name: string; partition_key: string }>(
    "SELECT name, partition_key FROM system.tables WHERE database = 'tokenlayer' AND name IN ('session_events', 'session_events_daily_next', 'session_events_monthly')");
  return new Map(rows.map(r => [r.name, r.partition_key]));
}

export type DaySize = { day: string; rows: number; lineBytes: number; bytes: number };
/**
 * Each day's share of a part's `bytes` on disk. Session text is most of the disk and its size varies by day (live, one
 * day held 14.5% of a part's rows and 21.2% of its line bytes), so a day counts as the larger of its share of
 * line_bytes (the source line's size) and of rows (the per-row columns).
 */
export function sizeDays(bytes: number, days: { day: string; rows: number; lineBytes: number }[]): DaySize[] {
  const rows = days.reduce((a, d) => a + d.rows, 0), lineBytes = days.reduce((a, d) => a + d.lineBytes, 0);
  return days.map(d => ({ ...d, bytes: Math.ceil(bytes * Math.max(d.rows / Math.max(1, rows), lineBytes > 0 ? d.lineBytes / lineBytes : 0)) }));
}

async function dayRows(ch: ClickHouse, table: string, part?: string) {
  const rows = await ch.queryJSON<{ part: string; day: string; rows: string; line_bytes: string }>(
    `SELECT _part AS part, toString(toYYYYMMDD(ts)) AS day, toString(count()) AS rows, toString(sum(line_bytes)) AS line_bytes
     FROM tokenlayer.${table} ${part ? `WHERE _part = '${part}'` : ""} GROUP BY part, day ORDER BY part, day`);
  const byPart = new Map<string, { day: string; rows: number; lineBytes: number }[]>();
  for (const r of rows) {
    if (!/^\d{8}$/.test(r.day)) throw new Error(`unexpected day ${r.day} in ${r.part}`);
    byPart.set(r.part, [...byPart.get(r.part) ?? [], { day: r.day, rows: Number(r.rows), lineBytes: Number(r.line_bytes) }]);
  }
  return byPart;
}

async function parts(ch: ClickHouse, table: string): Promise<PartPlan[]> {
  const rows = await ch.queryJSON<{ partition: string; part: string; bytes: string; rows: string }>(
    `SELECT partition_id AS partition, name AS part, toString(bytes_on_disk) AS bytes, toString(rows) AS rows
     FROM system.parts WHERE database = 'tokenlayer' AND table = '${table}' AND active ORDER BY bytes_on_disk, name`);
  const days = await dayRows(ch, table);
  return rows.map(r => {
    const bytes = Number(r.bytes);
    const maxDayBytes = Math.max(0, ...sizeDays(bytes, days.get(r.part) ?? []).map(d => d.bytes));
    return { partition: r.partition, part: r.part, bytes, rows: Number(r.rows), maxDayBytes };
  });
}

/** Migration 011's session_events statements (settings, then TTL), aimed at `table`. */
function retentionStatements(table: string): string[] {
  return readFileSync(join(SCHEMA_DIR, "011_session_retention.sql"), "utf8")
    .replaceAll("{{SESSION_RETENTION_DAYS}}", String(SESSION_RETENTION_DAYS))
    .split("\n").filter(l => !l.trim().startsWith("--")).join("\n")
    .split(";").map(s => s.trim()).filter(s => s.startsWith(`ALTER TABLE ${LIVE} `))
    .map(s => s.replace(`ALTER TABLE ${LIVE} `, `ALTER TABLE ${table} `));
}

/**
 * The archive's stored columns (no MATERIALIZED, ALIAS or EPHEMERAL), all of which the live table must store too:
 * a column the daily table lacks would otherwise vanish in the copy without a word.
 */
async function copyColumns(ch: ClickHouse): Promise<string> {
  const stored = async (table: string) => (await ch.queryJSON<{ name: string }>(
    `SELECT name FROM system.columns WHERE database = 'tokenlayer' AND table = '${table}' AND default_kind IN ('', 'DEFAULT') ORDER BY position`)).map(c => c.name);
  const [archive, live] = [await stored("session_events_monthly"), new Set(await stored("session_events"))];
  const lost = archive.filter(c => !live.has(c));
  if (lost.length) throw new Error(`archive columns ${lost.join(", ")} are not stored by the daily table; the copy would drop them. Add them to schema/004 first`);
  return archive.map(c => `\`${c.replaceAll("`", "``")}\``).join(", ");
}

async function utcNow(ch: ClickHouse): Promise<string> {
  return (await ch.exec("SELECT toString(now('UTC'))")).trim();
}

/** Copies still running on the server, from this login (a killed client's INSERT … SELECT keeps running). */
async function runningCopies(ch: ClickHouse): Promise<string[]> {
  return (await ch.queryJSON<{ query_id: string }>(
    `SELECT query_id FROM system.processes WHERE startsWith(query_id, '${COPY_QUERY_PREFIX}') ORDER BY query_id`)).map(r => r.query_id);
}

/**
 * Kept keys of the archive rows matching `archiveWhere`, and how many of them the live table (`liveWhere`) lacks at
 * the same or a newer version. ReplacingMergeTree keeps the newest version, so "missing = 0" means copying again
 * would add nothing a FINAL read shows.
 */
async function missingKeys(ch: ClickHouse, archiveWhere: string, liveWhere: string, at: string): Promise<{ kept: number; missing: number }> {
  const [r] = await ch.queryJSON<{ kept: string; missing: string }>(`
    SELECT toString(count()) AS kept, toString(countIf(l.at < a.at)) AS missing FROM
      (SELECT ${KEY} AS k, max(ingested_at) AS at FROM ${ARCHIVE} WHERE ${archiveWhere} AND ${keptRowsSQL(at)} GROUP BY k) AS a
      LEFT JOIN (SELECT ${KEY} AS k, max(ingested_at) AS at FROM ${LIVE} WHERE ${liveWhere} GROUP BY k) AS l USING (k)
    SETTINGS join_use_nulls = 0, max_threads = 2`);
  if (!r) throw new Error("missing-keys check returned no row");
  return { kept: Number(r.kept), missing: Number(r.missing) };
}

export async function repartitionSessionEvents(ch: ClickHouse, options: RepartitionOptions = {}): Promise<RepartitionReport> {
  fixed(ch, "session_events");
  const db = options.dryRun ? selectOnly(ch) : ch;
  const floorBytes = options.floorBytes ?? 30 * GiB;
  const k = options.amplification ?? DAY_AMPLIFICATION;
  const margin = options.killMarginBytes ?? KILL_MARGIN;
  const settleMs = options.settleMs ?? 600_000;
  const watchMs = options.watchMs ?? 1_000;
  const killConfirmMs = options.killConfirmMs ?? KILL_CONFIRM_MS;
  // A NaN or negative bound passes every comparison the wrong way and turns the disk checks off.
  const bad = Object.entries({ floorBytes, margin, settleMs, watchMs, killConfirmMs }).filter(([, v]) => !Number.isFinite(v) || v < 0);
  if (!Number.isFinite(k) || k < 1) bad.push(["amplification", k]);
  if (options.maxParts !== undefined && !(Number.isInteger(options.maxParts) && options.maxParts >= 0)) bad.push(["maxParts", options.maxParts]);
  if (bad.length) throw new Error(`refusing malformed options: ${bad.map(([n, v]) => `${n} = ${v}`).join(", ")}`);
  const shipperCheck = options.shipperCheck ?? (async () => (await import("./shipper-ready")).shipperProblems());
  const log = options.log ?? (() => {});
  const signal = options.signal;
  const free = () => (options.freeBytes ?? diskFreeBytes)(db);
  const partNeed = (p: PartPlan) => COPY_GROWTH * p.bytes + k * p.maxDayBytes;
  const need = (plan: PartPlan[]) => floorBytes + margin + Math.max(0, ...plan.map(partNeed));
  const largest = (plan: PartPlan[]) => plan.reduce<PartPlan | undefined>((a, p) => (!a || partNeed(p) > partNeed(a) ? p : a), undefined);
  const needText = (p: PartPlan) => `the ${gib(margin)} GiB kill margin and the part ${p.part} need (${COPY_GROWTH} x ${gib(p.bytes)} GiB, plus ${k} x its largest day of ${gib(p.maxDayBytes)} GiB)`;
  const abortIfAsked = () => { if (signal?.aborted) throw new Error("aborted before the next step; nothing is running on the server. Rerun to resume"); };
  const runStarted = Date.now();
  const runId = `${COPY_QUERY_PREFIX}${runStarted.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const copied: CopiedPart[] = [];

  const running = await runningCopies(db);
  if (running.length) {
    throw new Error(`a copy is still running on the server (${running.join(", ")}); a rerun now would copy the same rows twice at once. ` +
      `Wait for it to end, or KILL QUERY WHERE startsWith(query_id, '${COPY_QUERY_PREFIX}') SYNC, then rerun`);
  }
  let keys = await tableKeys(db);
  const liveKey = keys.get("session_events");
  if (!liveKey) throw new Error("tokenlayer.session_events does not exist");
  const monthly = (key?: string) => key === "toYYYYMM(ts)";
  const daily = (key?: string) => key === "toYYYYMMDD(ts)";
  if (!monthly(liveKey) && !daily(liveKey)) throw new Error(`unexpected session_events partition key ${liveKey}`);

  if (options.dryRun) {
    const source = monthly(liveKey) ? "session_events"
      : monthly(keys.get("session_events_daily_next")) ? "session_events_daily_next"
      : keys.has("session_events_monthly") ? "session_events_monthly" : undefined;
    const freeNow = await free();
    if (!source) return { state: "already-daily", freeBytes: freeNow, floorBytes, needBytes: floorBytes, copied, remaining: [] };
    const plan = await parts(db, source);
    const actions = [
      ...(source === "session_events" ? ["create session_events_daily_next with 011's TTL", "EXCHANGE it with session_events"] : []),
      ...(source !== "session_events_monthly" ? [`RENAME the monthly table to session_events_monthly`] : []),
      "SYSTEM STOP MERGES session_events_monthly",
      `MODIFY SETTING ${Object.entries(WINDOW_SETTINGS).map(([n, v]) => `${n} = ${v}`).join(", ")} on session_events until done`,
      `copy ${plan.length} parts one day at a time, smallest first, then DROP each`,
      "DROP the empty archive",
    ];
    const big = largest(plan);
    const shippers = source === "session_events" ? await shipperCheck() : [];
    const refusal = [
      ...(big && freeNow < need(plan) ? [`free ${gib(freeNow)} GiB is under the ${gib(need(plan))} GiB that the ${gib(floorBytes)} GiB floor plus ${needText(big)}`] : []),
      ...shippers.map(s => `shipper not ready: ${s}`),
    ].join("; ") || undefined;
    return { state: "dry-run", freeBytes: freeNow, floorBytes, needBytes: need(plan), copied, remaining: plan, actions, ...(refusal ? { refusal } : {}) };
  }

  // Step 1 (or its crash leftovers).
  if (monthly(liveKey)) {
    const plan = await parts(ch, "session_events");
    const freeNow = await free();
    if (keys.has("session_events_monthly")) throw new Error("session_events is monthly but session_events_monthly exists; inspect before retrying");
    const big = largest(plan);
    if (big && freeNow < need(plan)) {
      throw new Error(`disk floor: free ${gib(freeNow)} GiB is under the ${gib(need(plan))} GiB that the ${gib(floorBytes)} GiB floor ` +
        `plus ${needText(big)}; nothing changed`);
    }
    const shippers = await shipperCheck();
    if (shippers.length) {
      throw new Error(`shippers not ready for daily partitions (a batch over 100 days would fail on every retry): ${shippers.join("; ")}; nothing changed`);
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
    abortIfAsked();
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
    return { state: "already-daily", freeBytes: await free(), floorBytes, needBytes: floorBytes, copied, remaining: [] };
  }
  if (!monthly(keys.get("session_events_monthly"))) throw new Error("session_events_monthly is not monthly; inspect before retrying");
  // Parts must hold still while they are copied and dropped one by one; the archive's TTL merges would also rewrite them.
  // In memory only: a server restart starts them again, so rerun promptly after one.
  await ch.exec(`SYSTEM STOP MERGES ${ARCHIVE}`);

  // Step 2.
  await ch.exec(`ALTER TABLE ${LIVE} MODIFY SETTING ${Object.entries(WINDOW_SETTINGS).map(([n, v]) => `${n} = ${v}`).join(", ")}`);
  let remaining = await parts(ch, "session_events_monthly");
  const columns = await copyColumns(ch);
  const settings = Object.entries({ ...COPY_SETTINGS, ...options.extraCopySettings }).map(([name, v]) => `${name} = ${v}`).join(", ");
  let stopped: string | undefined;
  copying: while (remaining.length) {
    if (options.maxParts !== undefined && copied.length >= options.maxParts) break;
    abortIfAsked();
    const p = remaining[0];
    if (!/^\d{6}$/.test(p.partition) || !/^\w+$/.test(p.part)) throw new Error(`unexpected archive part ${p.part}`);
    const started = Date.now();
    const cutoff = `toDateTime('${await utcNow(ch)}', 'UTC')`;
    const days = sizeDays(p.bytes, (await dayRows(ch, "session_events_monthly", p.part)).get(p.part) ?? []);
    // Days still to copy: a rerun skips days an earlier run's copy already landed (or with nothing kept).
    const todo: DaySize[] = [];
    for (const d of days) {
      abortIfAsked();
      const before = await missingKeys(ch, `_part = '${p.part}' AND toYYYYMMDD(ts) = ${d.day}`, `toYYYYMMDD(ts) = ${d.day}`, cutoff);
      if (before.missing !== 0) todo.push(d);
    }
    const skippedDays = days.length - todo.length;
    // The up-front test again, for what is left of this part: it also holds a resumed run, which skips step 1.
    const todoNeed = todo.length
      ? floorBytes + margin + COPY_GROWTH * Math.min(p.bytes, todo.reduce((a, d) => a + d.bytes, 0)) + k * Math.max(...todo.map(d => d.bytes)) : 0;
    const settled = async (needBytes: number, what: string) => {
      let freeNow = await free();
      if (freeNow < needBytes) log(`  waiting up to ${settleMs / 1000} s for free disk: ${gib(freeNow)} GiB, ${what} needs ${gib(needBytes)}`);
      for (const deadline = Date.now() + settleMs; freeNow < needBytes && Date.now() < deadline; freeNow = await free()) {
        abortIfAsked();
        await Bun.sleep(Math.min(5_000, settleMs));
      }
      return freeNow < needBytes ? `free ${gib(freeNow)} GiB is under the ${gib(needBytes)} GiB ${what} needs (floor ${gib(floorBytes)} + margin ${gib(margin)} GiB)` : undefined;
    };
    if (todo.length) {
      stopped = await settled(todoNeed, `${p.part}'s ${todo.length} days left to copy`);
      if (stopped) break copying;
    }
    for (const d of todo) {
      abortIfAsked();
      // The day's share of the part's bytes; its copy and the merges of it take about `k` times that.
      stopped = await settled(floorBytes + margin + k * d.bytes, `${p.part} day ${d.day} (${k} x ${gib(d.bytes)} GiB)`);
      if (stopped) break copying;
      const queryId = `${runId}-${p.part}-${d.day}`;
      stopped = await copyWatched(ch, `INSERT INTO ${LIVE} (${columns}) SELECT ${columns} FROM ${ARCHIVE} WHERE _part = '${p.part}' AND toYYYYMMDD(ts) = ${d.day} AND ${keptRowsSQL(cutoff)}
        SETTINGS ${settings}`, queryId, { free, killBelow: floorBytes + margin, watchMs, killConfirmMs, signal });
      if (signal?.aborted) throw new Error(`aborted: killed ${queryId} on the server; ${p.part} stays in the archive. Rerun to resume`);
      if (stopped) break copying;
      log(`  ${p.part} day ${d.day}: ${d.rows} rows (~${gib(d.bytes)} GiB) copied, ${((Date.now() - started) / 1000).toFixed(1)} s into the part`);
    }
    // Every kept key must be in the live table before its archive part goes. A day that expires completely between
    // the copy and this check may already be dropped by the live TTL, so the check leaves out the next hour: those
    // rows are copied but not verified, and they expire within the hour anyway.
    const check = await missingKeys(ch, `_part = '${p.part}'`, `toYYYYMM(ts) = ${p.partition}`, `(${cutoff} + INTERVAL 1 HOUR)`);
    if (check.missing !== 0) throw new Error(`part ${p.part}: ${check.missing} kept keys missing after the copy; the archive part is kept`);
    await ch.exec(`ALTER TABLE ${ARCHIVE} DROP PART '${p.part}'`);
    const done = { ...p, kept: check.kept, days: days.length, skippedDays, seconds: (Date.now() - started) / 1000 };
    copied.push(done);
    log(`copied ${p.part}: ${p.rows} rows (${gib(p.bytes)} GiB, ${days.length} days, ${skippedDays} already in) → ${done.kept} kept keys in ${done.seconds.toFixed(1)} s`);
    remaining = await parts(ch, "session_events_monthly");
  }
  if (stopped) log(`stop: ${stopped}`);

  // Step 3. An insert that resolved the monthly table before the EXCHANGE still writes into the archive; DROP TABLE
  // would wait for it and then drop its rows. Any insert older than this run could be one.
  if (!remaining.length && !stopped) {
    const seconds = Math.ceil((Date.now() - runStarted) / 1000);
    const old = await ch.queryJSON<{ query_id: string }>(
      `SELECT query_id FROM system.processes WHERE query_kind = 'Insert' AND NOT startsWith(query_id, '${COPY_QUERY_PREFIX}')
       AND positionCaseInsensitive(query, 'session_events') > 0 AND elapsed >= ${seconds}`);
    if (old.length) stopped = `inserts older than this run are still running (${old.map(o => o.query_id).join(", ")}); rerun once they end`;
  }
  remaining = await parts(ch, "session_events_monthly");
  if (remaining.length || stopped) {
    return { state: "partial", freeBytes: await free(), floorBytes, needBytes: need(remaining), copied, remaining, ...(stopped ? { stopped } : {}) };
  }
  if ((await ch.exec(`SELECT count() FROM ${ARCHIVE}`)).trim() !== "0") throw new Error("session_events_monthly has no active parts but still counts rows; inspect");
  await ch.exec(`DROP TABLE ${ARCHIVE} SYNC`);
  await ch.exec(RESET_WINDOW_SETTINGS(LIVE));
  log("done: the monthly archive is empty and dropped");
  return { state: "done", freeBytes: await free(), floorBytes, needBytes: floorBytes, copied, remaining };
}

/**
 * Run one copy under `queryId` and watch it. KILL it on the server when free disk falls under `killBelow`, when free
 * disk cannot be read FAILED_READS_TO_KILL times in a row, or when `signal` aborts; rows it already wrote stay, and the
 * archive part is kept, so a rerun copies the day again. A KILL is confirmed: it is re-issued until the INSERT has
 * ended and system.processes no longer lists it (a KILL sent before the query is listed does nothing). Returns why it
 * was killed, or undefined when it finished; throws when the kill cannot be confirmed within `killConfirmMs`.
 */
async function copyWatched(ch: ClickHouse, sql: string, queryId: string,
  o: { free: () => Promise<number>; killBelow: number; watchMs: number; killConfirmMs: number; signal?: AbortSignal }): Promise<string | undefined> {
  if (o.signal?.aborted) return "aborted";
  let reason: string | undefined;
  let ended = false, failure: unknown;
  const insert = ch.exec(sql, { queryId }).then(() => {}, error => { failure = error; }).finally(() => { ended = true; });
  let onAbort = () => {};
  const aborted = new Promise<void>(resolve => { onAbort = () => { reason ??= "aborted"; resolve(); }; });
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const tick = () => Promise.race([Bun.sleep(o.watchMs), insert, aborted]);
  try {
    for (let failedReads = 0; !ended && !reason;) {
      await tick();
      if (ended || reason) break;
      try {
        const f = await o.free();
        failedReads = 0;
        if (f < o.killBelow) reason = `free ${gib(f)} GiB fell under ${gib(o.killBelow)} GiB (floor plus kill margin) during ${queryId}; killed it`;
      } catch (error) {
        if (++failedReads >= FAILED_READS_TO_KILL) {
          reason = `free disk could not be read ${failedReads} times in a row during ${queryId} (${String(error).slice(0, 120)}); killed it`;
        }
      }
    }
    if (reason) {
      for (const deadline = Date.now() + o.killConfirmMs; ;) {
        await ch.exec(`KILL QUERY WHERE query_id = '${queryId}' ASYNC`).catch(() => {});
        await Promise.race([Bun.sleep(o.watchMs), insert]);
        const listed = ended ? await ch.queryJSON(`SELECT 1 FROM system.processes WHERE query_id = '${queryId}'`).then(r => r.length > 0, () => true) : true;
        if (!listed) break;
        if (Date.now() >= deadline) {
          throw new Error(`${reason}, but the kill of ${queryId} is not confirmed after ${o.killConfirmMs / 1000} s: it may still be writing. ` +
            `Run KILL QUERY WHERE query_id = '${queryId}' SYNC, watch df, and rerun only once system.processes no longer lists it`);
        }
      }
    }
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
  }
  if (!reason && failure) throw failure;
  // Say how the copy ended when the kill may not have been what ended it.
  if (reason && failure && !/QUERY_WAS_CANCELLED|exception 394\b/.test(String(failure))) reason += ` (the copy itself ended: ${String(failure).slice(0, 160)})`;
  else if (reason && !failure) reason += " (the copy had already finished)";
  return reason;
}

/** The CLI's flags. Anything malformed refuses before connecting: a NaN floor would pass every disk check. */
export function parseRepartitionArgs(args: string[]): { dryRun: boolean; floorBytes?: number; maxParts?: number; amplification?: number } {
  const numeric: Record<string, RegExp> = { "--floor-gib": /^\d+(\.\d+)?$/, "--disk-multiplier": /^\d+(\.\d+)?$/, "--max-parts": /^\d+$/ };
  const seen = new Map<string, number>();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") { if (dryRun) throw new Error("--dry-run given twice"); dryRun = true; continue; }
    const shape = numeric[a];
    if (!shape) throw new Error(`unknown argument ${JSON.stringify(a)}; flags: --dry-run, --floor-gib <GiB>, --disk-multiplier <x>, --max-parts <n>`);
    if (seen.has(a)) throw new Error(`${a} given twice`);
    const v = args[++i];
    if (v === undefined || !shape.test(v)) throw new Error(`${a} needs ${a === "--max-parts" ? "a whole number" : "a plain number"}, not ${JSON.stringify(v ?? "")}`);
    seen.set(a, Number(v));
  }
  const floorGiB = seen.get("--floor-gib"), multiplier = seen.get("--disk-multiplier");
  if (floorGiB !== undefined && !(floorGiB > 0)) throw new Error("--floor-gib must be over 0");
  if (multiplier !== undefined && !(multiplier >= 1)) throw new Error("--disk-multiplier must be at least 1: a day's copy takes more disk than the day");
  return {
    dryRun,
    ...(floorGiB !== undefined ? { floorBytes: floorGiB * GiB } : {}),
    ...(seen.has("--max-parts") ? { maxParts: seen.get("--max-parts") } : {}),
    ...(multiplier !== undefined ? { amplification: multiplier } : {}),
  };
}

if (import.meta.main) {
  const { installErrorHandlers, writeErr, writeOut } = await import("./egress");
  installErrorHandlers();
  const { ClickHouse } = await import("./clickhouse");
  let parsed: ReturnType<typeof parseRepartitionArgs>;
  try {
    parsed = parseRepartitionArgs(process.argv.slice(2));
  } catch (error) {
    writeErr(`schema:repartition: ${(error as Error).message}; nothing ran`);
    process.exit(2);
  }
  // Ctrl-C (or a kill) must not leave the INSERT … SELECT running on the server: abort kills it first.
  const abort = new AbortController();
  let signals = 0;
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(name, () => {
      if (++signals > 1) process.exit(130);
      writeErr(`${name}: killing the running copy on the server, then stopping (again to quit at once)`);
      abort.abort();
    });
  }
  const report = await repartitionSessionEvents(ClickHouse.fromEnv(), {
    ...parsed,
    signal: abort.signal,
    log: line => writeOut(line),
  });
  writeOut(JSON.stringify(report));
}
