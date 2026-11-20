-- Preserve first ingestion outside session_events' latest-version replacement.
-- The lag identity is machine + source time + exact content, across file/generation replays.
-- No POPULATE/backfill: surviving raw versions cannot prove historical first ingestion.
-- Install this before collecting a complete live window (see docs/ratchet.md).
CREATE TABLE IF NOT EXISTS tokenlayer.session_first_ingest
(
    machine LowCardinality(String),
    ts DateTime64(3, 'UTC'),
    content_hash String,
    first_ingested_at SimpleAggregateFunction(min, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(ts)
ORDER BY (machine, ts, content_hash)
TTL toDateTime(ts) + INTERVAL 1 DAY
SETTINGS max_bytes_to_merge_at_max_space_in_pool = 1073741824;

CREATE MATERIALIZED VIEW IF NOT EXISTS tokenlayer.mv_session_first_ingest
TO tokenlayer.session_first_ingest AS
SELECT machine, ts, content_hash, min(ingested_at) AS first_ingested_at
FROM tokenlayer.session_events
WHERE ts > now64(3) - INTERVAL 1 DAY
GROUP BY machine, ts, content_hash;
