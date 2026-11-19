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
 *   1. Refuse, changing nothing, unless free disk covers the floor plus the most demanding part: COPY_GROWTH times
 *      the part (its copied days stay until it drops) plus DAY_AMPLIFICATION times its largest day. Create
 *      session_events_daily_next from schema/004 with migration 011's TTL, then EXCHANGE it with the live table and
 *      rename the old one to session_events_monthly. Shippers keep inserting; from here they write daily parts.
 *   2. With the archive's merges stopped and the live table in WINDOW_SETTINGS, for each archive part, smallest
 *      first, one day of the part at a time: skip the day if the live table already holds every kept key at the same
 *      or a newer version (a rerun after a kill); otherwise wait until free disk covers DAY_AMPLIFICATION times the
 *      day, then INSERT the day's kept rows under their own query_id while a watchdog KILLs that query if free disk
 *      falls under the floor. Free disk is read before every day, so garbage from earlier days' merges is counted
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
/**
 * Runbook back-out: the monthly archive goes live again with the merges this run stopped on it restarted, and the
 * daily table (now named session_events_monthly) drops its window settings.
 */
export const BACK_OUT_SQL = [`EXCHANGE TABLES ${LIVE} AND ${ARCHIVE}`, `SYSTEM START MERGES ${LIVE}`, RESET_WINDOW_SETTINGS(ARCHIVE)];

export type PartPlan = { partition: string; part: string; bytes: number; rows: number; maxDayBytes: number };
export type CopiedPart = PartPlan & { kept: number; days: number; skippedDays: number; seconds: number };
export type RepartitionReport = {
  state: "dry-run" | "already-daily" | "partial" | "done";
  freeBytes: number;
  floorBytes: number;
  /**
   * Free disk the most demanding remaining part needs to finish without the floor breaking: the floor, plus its
   * copied days (COPY_GROWTH times the part, kept until the part drops), plus DAY_AMPLIFICATION times its largest day.
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

async function parts(ch: ClickHouse, table: string): Promise<PartPlan[]> {
  const rows = await ch.queryJSON<{ partition: string; part: string; bytes: string; rows: string; max_day: string }>(
    `SELECT partition_id AS partition, name AS part, toString(bytes_on_disk) AS bytes, toString(rows) AS rows, toString(d.max_day) AS max_day
     FROM system.parts AS p LEFT JOIN (
       SELECT _part, max(c) AS max_day FROM (SELECT _part, toYYYYMMDD(ts) AS day, count() AS c FROM tokenlayer.${table} GROUP BY _part, day) GROUP BY _part
     ) AS d ON d._part = p.name
     WHERE p.database = 'tokenlayer' AND p.table = '${table}' AND p.active ORDER BY p.bytes_on_disk, p.name`);
  return rows.map(r => {
    const bytes = Number(r.bytes), n = Number(r.rows);
    return { partition: r.partition, part: r.part, bytes, rows: n, maxDayBytes: Math.ceil(bytes * Number(r.max_day) / Math.max(1, n)) };
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
  const settleMs = options.settleMs ?? 600_000;
  const watchMs = options.watchMs ?? 1_000;
  const log = options.log ?? (() => {});
  const signal = options.signal;
  const free = () => (options.freeBytes ?? diskFreeBytes)(db);
  const partNeed = (p: PartPlan) => COPY_GROWTH * p.bytes + k * p.maxDayBytes;
  const need = (plan: PartPlan[]) => floorBytes + Math.max(0, ...plan.map(partNeed));
  const largest = (plan: PartPlan[]) => plan.reduce<PartPlan | undefined>((a, p) => (!a || partNeed(p) > partNeed(a) ? p : a), undefined);
  const needText = (p: PartPlan) => `the part ${p.part} needs (${COPY_GROWTH} x ${gib(p.bytes)} GiB, plus ${k} x its largest day of ${gib(p.maxDayBytes)} GiB)`;
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
    const refusal = big && freeNow < need(plan)
      ? `free ${gib(freeNow)} GiB is under the ${gib(need(plan))} GiB that the ${gib(floorBytes)} GiB floor plus what ${needText(big)}`
      : undefined;
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
        `plus what ${needText(big)}; nothing changed`);
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
    const days = await ch.queryJSON<{ day: string; rows: string }>(
      `SELECT toString(toYYYYMMDD(ts)) AS day, toString(count()) AS rows FROM ${ARCHIVE} WHERE _part = '${p.part}' GROUP BY day ORDER BY day`);
    let skippedDays = 0;
    for (const d of days) {
      if (!/^\d{8}$/.test(d.day)) throw new Error(`unexpected day ${d.day} in ${p.part}`);
      abortIfAsked();
      const dayWhere = `_part = '${p.part}' AND toYYYYMMDD(ts) = ${d.day}`;
      const before = await missingKeys(ch, dayWhere, `toYYYYMMDD(ts) = ${d.day}`, cutoff);
      if (before.missing === 0) { skippedDays++; continue; } // nothing kept, or an earlier run's copy already landed
      // The day's share of the part's bytes; its copy and the merges of it take about `k` times that.
      const dayBytes = Math.ceil(p.bytes * Number(d.rows) / Math.max(1, p.rows));
      let freeNow = await free();
      if (freeNow - k * dayBytes < floorBytes) log(`  waiting up to ${settleMs / 1000} s for free disk: ${gib(freeNow)} GiB, ${p.part} day ${d.day} needs ${gib(floorBytes + k * dayBytes)}`);
      for (const deadline = Date.now() + settleMs; freeNow - k * dayBytes < floorBytes && Date.now() < deadline; freeNow = await free()) {
        abortIfAsked();
        await Bun.sleep(Math.min(5_000, settleMs));
      }
      if (freeNow - k * dayBytes < floorBytes) {
        stopped = `free ${gib(freeNow)} GiB minus ${k} x ${gib(dayBytes)} GiB for ${p.part} day ${d.day} is under the ${gib(floorBytes)} GiB floor`;
        break copying;
      }
      const queryId = `${runId}-${p.part}-${d.day}`;
      stopped = await copyWatched(ch, `INSERT INTO ${LIVE} (${columns}) SELECT ${columns} FROM ${ARCHIVE} WHERE ${dayWhere} AND ${keptRowsSQL(cutoff)}
        SETTINGS ${settings}`, queryId, { free, floorBytes, watchMs, signal });
      if (signal?.aborted) throw new Error(`aborted: killed ${queryId} on the server; ${p.part} stays in the archive. Rerun to resume`);
      if (stopped) break copying;
      log(`  ${p.part} day ${d.day}: ${d.rows} rows (~${gib(dayBytes)} GiB) copied, ${((Date.now() - started) / 1000).toFixed(1)} s into the part`);
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
 * Run one copy under `queryId` and watch it: if free disk falls under the floor, or `signal` aborts, KILL the query on
 * the server (rows it already wrote stay; the archive part is kept, so a rerun copies the day again). Returns why it
 * was killed, or undefined when it finished.
 */
async function copyWatched(ch: ClickHouse, sql: string, queryId: string,
  o: { free: () => Promise<number>; floorBytes: number; watchMs: number; signal?: AbortSignal }): Promise<string | undefined> {
  let reason: string | undefined;
  let killing: Promise<unknown> = Promise.resolve();
  const kill = (why: string) => {
    if (reason) return;
    reason = why;
    killing = ch.exec(`KILL QUERY WHERE query_id = '${queryId}' SYNC`).catch(() => {});
  };
  const onAbort = () => kill("aborted");
  if (o.signal?.aborted) return "aborted";
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let finished = false;
  const insert = ch.exec(sql, { queryId }).finally(() => { finished = true; });
  const watch = (async () => {
    while (!finished && !reason) {
      await Promise.race([Bun.sleep(o.watchMs), insert.catch(() => {})]);
      if (finished || reason) break;
      const f = await o.free().catch(() => Number.POSITIVE_INFINITY);
      if (f < o.floorBytes) kill(`free ${gib(f)} GiB fell under the ${gib(o.floorBytes)} GiB floor during ${queryId}; killed it`);
    }
  })();
  try {
    await insert;
  } catch (error) {
    if (!reason) throw error;
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await watch;
    await killing;
  }
  return reason;
}

if (import.meta.main) {
  const { installErrorHandlers, writeErr, writeOut } = await import("./egress");
  installErrorHandlers();
  const { ClickHouse } = await import("./clickhouse");
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const floorGiB = flag("--floor-gib");
  const maxParts = flag("--max-parts");
  const multiplier = flag("--disk-multiplier");
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
    dryRun: args.includes("--dry-run"),
    floorBytes: floorGiB === undefined ? undefined : Number(floorGiB) * GiB,
    maxParts: maxParts === undefined ? undefined : Number(maxParts),
    amplification: multiplier === undefined ? undefined : Number(multiplier),
    signal: abort.signal,
    log: line => writeOut(line),
  });
  writeOut(JSON.stringify(report));
}
