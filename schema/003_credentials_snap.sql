-- One row per credential per tokenlayer-steer poll: the reset/quota history behind each priority move.
CREATE TABLE IF NOT EXISTS tokenlayer.credentials_snap
(
    ts               DateTime64(3, 'UTC')            CODEC(Delta, ZSTD(3)),
    hub              LowCardinality(String),
    credential       LowCardinality(String),
    provider         LowCardinality(String),
    priority         Int32,
    status           LowCardinality(String),
    disabled         Bool,
    unavailable      Bool,
    next_retry_after Nullable(DateTime64(3, 'UTC')),
    reset_5h         Nullable(DateTime64(3, 'UTC')),
    reset_7d         Nullable(DateTime64(3, 'UTC')),
    utilization_5h   Nullable(Float32),
    utilization_7d   Nullable(Float32),
    signals          Map(LowCardinality(String), String) CODEC(ZSTD(3)),
    action           LowCardinality(String),
    ingested_at      DateTime64(3, 'UTC')            DEFAULT now64(3) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (credential, ts)
SETTINGS non_replicated_deduplication_window = 10000;
