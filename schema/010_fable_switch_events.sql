-- Local JSONL remains durable if ClickHouse is unavailable. Retries use deterministic batch tokens.
CREATE TABLE IF NOT EXISTS tokenlayer.fable_switch_events
(
    ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(3)),
    op String,
    stage LowCardinality(String),
    payload String CODEC(ZSTD(3)),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (op, ts)
SETTINGS non_replicated_deduplication_window = 10000;
