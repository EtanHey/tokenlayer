// SQL for the live ratchet rows (ratchet/live.ts), shared with their fixtures.

// session_events is a ReplacingMergeTree partitioned by toYYYYMMDD(ts) since R12 (toYYYYMM before), and every version
// of a key is the same line with the same ts, so versions never span partitions (0 of 8.84M keys did monthly on
// 2026-11-19; R12's runbook re-checks it per day, since an Antigravity replay mid-file can carry a different ts). Per-partition
// FINAL is then exact, and it lets ClickHouse prune parts by ts. Plain FINAL cannot push the ts filter below
// the merge and reads every part: 4906/4906 granules (~600 ms) against 219 (~45 ms) on 2026-11-19.
export const FINAL_PER_PARTITION = 'do_not_merge_across_partitions_select_final=1';

export const LIVE_QUERY_SQL = `SELECT session_id, count() FROM tokenlayer.session_events FINAL WHERE ts>now()-INTERVAL 1 DAY GROUP BY session_id SETTINGS use_query_cache=0, ${FINAL_PER_PARTITION}`;

/**
 * The 24 h cache rows: numerators over total cache creation (W5m + W1h), per-partition FINAL as above. On
 * 2026-11-19 plain FINAL took p50 760 ms (cache ratio) and 17.6 s (w1h share, which parses every raw line of the
 * table); per partition, 43 ms and 457 ms, with identical results.
 */
const RATIO_EXPR: Record<string, string> = {
  cache_read_write_ratio_24h: 'sum(cache_read_tokens)/nullIf(sum(cache_creation_tokens),0)',
  w1h_share_24h: "sum(JSONExtractUInt(raw,'message','usage','cache_creation','ephemeral_1h_input_tokens'))/nullIf(sum(cache_creation_tokens),0)",
};
export const liveRatioSQL = (id: string) => `SELECT ${RATIO_EXPR[id] ?? 'NULL'} FROM tokenlayer.session_events FINAL WHERE ts>now()-INTERVAL 1 DAY SETTINGS ${FINAL_PER_PARTITION}`;

/** Live events: written in the last hour (a replay of older history, or a 1970-dated import, is not live). */
export const SHIPPER_WINDOW_MINUTES = 60;
/** Clock skew allowed between a Mac and the M1 before an event counts as future-dated and is ignored. */
export const SHIPPER_SKEW_MINUTES = 5;

/**
 * How far behind the live shippers are: per machine, the p95 of first-ingest minus event time over events
 * written in the last hour; the worst machine wins, so a quiet machine's backlog is not averaged away.
 * A generation replay re-ships the same line (same ts and content) later; the first ingest is the shipper's
 * lag, so replays never count. No live events means nothing is waiting: 0.
 */
export const shipperLagSQL = (windowMinutes = SHIPPER_WINDOW_MINUTES, skewMinutes = SHIPPER_SKEW_MINUTES) => `SELECT max(p95) FROM (
  SELECT machine, quantileExact(0.95)(lag_s) AS p95 FROM (
    SELECT machine, dateDiff('millisecond', ts, min(ingested_at)) / 1000 AS lag_s
    FROM tokenlayer.session_events
    WHERE ts > now64(3) - INTERVAL ${windowMinutes} MINUTE AND ts <= now64(3) + INTERVAL ${skewMinutes} MINUTE
    GROUP BY machine, ts, content_hash)
  GROUP BY machine)`;
