-- One row per ship daemon pass on each Mac: at most one a minute while the result stays the same, and at once when
-- it changes. The live rows ship_heartbeat_age_s_m1 / _m4 read the newest ingested_at per machine, so a shipper that
-- stops and never restarts fails a row instead of showing nothing. Server time (ingested_at) is the clock, never the
-- Mac's. No session content and no paths: machine, counts and a fixed error class only.
CREATE TABLE IF NOT EXISTS tokenlayer.ship_heartbeat
(
    machine LowCardinality(String),
    ts DateTime64(3, 'UTC'),
    result LowCardinality(String),
    error_class LowCardinality(String),
    files UInt32,
    lines UInt64,
    bytes UInt64,
    duration_ms UInt32,
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (machine, ingested_at)
TTL toDateTime(ingested_at) + INTERVAL 30 DAY;
