-- One row per JSONL line of a Claude Code / Codex / T3 session, shipped by tokenlayer-ship on each Mac.
-- Idempotent: a line is identified by (machine, path, byte_offset); harness is a pure function of path,
-- so it can lead the sort key without changing the dedupe identity.
CREATE TABLE IF NOT EXISTS tokenlayer.session_events
(
    machine               LowCardinality(String),
    harness               LowCardinality(String),
    path                  String                 CODEC(ZSTD(3)),
    byte_offset           UInt64                 CODEC(Delta, ZSTD(3)),
    line_bytes            UInt32                 CODEC(T64, ZSTD(3)),
    ts                    DateTime64(3, 'UTC')   CODEC(Delta, ZSTD(3)),
    session_id            String                 CODEC(ZSTD(3)),
    project               LowCardinality(String),
    cwd                   LowCardinality(String),
    type                  LowCardinality(String),
    role                  LowCardinality(String),
    model                 LowCardinality(String),
    input_tokens          UInt64                 CODEC(T64, ZSTD(3)),
    output_tokens         UInt64                 CODEC(T64, ZSTD(3)),
    cache_read_tokens     UInt64                 CODEC(T64, ZSTD(3)),
    cache_creation_tokens UInt64                 CODEC(T64, ZSTD(3)),
    reasoning_tokens      UInt64                 CODEC(T64, ZSTD(3)),
    raw                   String                 CODEC(ZSTD(6)),
    ingested_at           DateTime64(3, 'UTC')   DEFAULT now64(3) CODEC(Delta, ZSTD(3)),

    INDEX idx_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_project project    TYPE set(1024)           GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (machine, harness, path, byte_offset)
SETTINGS non_replicated_deduplication_window = 10000;
