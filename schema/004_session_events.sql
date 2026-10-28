-- One row per JSONL line of a Claude Code / Codex / T3 session, shipped by tokenlayer-ship on each Mac.
-- Idempotent: a line is identified by (machine, path, generation, byte_offset), the whole sort key.
-- generation is the file's content identity (hash of its first line): a file rotated, replaced or rewritten at the
-- same path with a different first line is a new generation, so archived history is never overwritten, while a
-- re-read of the same file (lost checkpoint, retry) maps to the same rows. harness stays out of the key:
-- a Claude file's harness can be decided only after its first lines, and a reshipped row must replace, not duplicate.
-- Reads that count rows need FINAL (or a GROUP BY on the key): a replay with new chunk boundaries inserts
-- duplicates that only a background merge collapses. raw is the line after the shared secret redactor.
CREATE TABLE IF NOT EXISTS tokenlayer.session_events
(
    machine               LowCardinality(String),
    harness               LowCardinality(String),
    path                  String                 CODEC(ZSTD(3)),
    generation            String                 CODEC(ZSTD(3)),
    byte_offset           UInt64                 CODEC(Delta, ZSTD(3)),
    line_bytes            UInt32                 CODEC(T64, ZSTD(3)),
    ts                    DateTime64(3, 'UTC')   CODEC(Delta, ZSTD(3)),
    session_id            String                 CODEC(ZSTD(3)),
    project               LowCardinality(String),
    cwd                   LowCardinality(String),
    type                  LowCardinality(String),
    role                  LowCardinality(String),
    model                 LowCardinality(String),
    message_id            String                 CODEC(ZSTD(3)),
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
ORDER BY (machine, path, generation, byte_offset)
SETTINGS non_replicated_deduplication_window = 10000;
