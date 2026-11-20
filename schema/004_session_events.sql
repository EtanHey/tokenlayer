-- One row per JSONL line of a Claude Code / Codex / T3 session, shipped by tokenlayer-ship on each Mac.
-- Idempotent: (machine, path, generation, byte_offset, content_hash) is the whole replacement key.
-- SHA-256 of the exact source line (including LF), before decoding, prevents content replacement.
-- generation derives from device, inode and birthtime, extended by revision hashes on rewrites.
-- harness stays out of the key so a late harness decision replaces rows.
-- Reads that count rows need FINAL (or a GROUP BY on the key): a replay with new chunk boundaries inserts
-- duplicates that only a background merge collapses. raw retains the source line including its terminator.
-- R12: one partition per UTC day, and the 30-day TTL (migration 011) only drops parts whose rows have all expired.
-- A day therefore goes as a whole once its last row is 30 days old (rows live 30 to 31 days), and TTL never
-- rewrites a part to trim an hour of rows; the TTL's WHERE still keeps Antigravity and January 1970 rows through it.
-- Tables created before R12 are monthly: `bun run schema:repartition` moves them (docs/telemetry.md).
CREATE TABLE IF NOT EXISTS tokenlayer.session_events
(
    machine               LowCardinality(String),
    harness               LowCardinality(String),
    path                  String                 CODEC(ZSTD(3)),
    generation            String                 CODEC(ZSTD(3)),
    byte_offset           UInt64                 CODEC(Delta, ZSTD(3)),
    content_hash          String                 CODEC(ZSTD(3)),
    line_bytes            UInt32                 CODEC(T64, ZSTD(3)),
    ts                    DateTime64(3, 'UTC')   CODEC(Delta, ZSTD(3)),
    session_id            String                 CODEC(ZSTD(3)),
    session_alias         String                 CODEC(ZSTD(3)),
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
    credits               Nullable(Float64)      DEFAULT NULL,
    raw                   String                 CODEC(ZSTD(6)),
    ingested_at           DateTime64(3, 'UTC')   DEFAULT now64(3) CODEC(Delta, ZSTD(3)),
    -- Facts the views take from raw, extracted once at insert (R7) so a view read never decompresses raw (51 GiB).
    -- Pure functions of raw, type and role: every version of a key carries the same values. Parts written before the
    -- column existed compute it from raw on read until MATERIALIZE COLUMN (docs/telemetry.md) rewrites them.
    raw_has_created_at    UInt8                  MATERIALIZED JSONHas(raw, 'created_at'),
    raw_has_message       UInt8                  MATERIALIZED JSONHas(raw, 'message'),
    token_total           String                 MATERIALIZED if(type = 'event_msg' AND role = 'token_count', coalesce(nullIf(JSONExtractRaw(raw, 'payload', 'info', 'total_token_usage'), ''), 'null'), '') CODEC(ZSTD(3)),
    codex_primary_pct     Nullable(Float64)      MATERIALIZED if(type = 'event_msg' AND role = 'token_count', JSONExtract(raw, 'payload', 'rate_limits', 'primary', 'used_percent', 'Nullable(Float64)'), NULL),
    codex_primary_minutes Nullable(UInt64)       MATERIALIZED if(type = 'event_msg' AND role = 'token_count', JSONExtract(raw, 'payload', 'rate_limits', 'primary', 'window_minutes', 'Nullable(UInt64)'), NULL),
    codex_secondary_pct   Nullable(Float64)      MATERIALIZED if(type = 'event_msg' AND role = 'token_count', JSONExtract(raw, 'payload', 'rate_limits', 'secondary', 'used_percent', 'Nullable(Float64)'), NULL),
    codex_secondary_minutes Nullable(UInt64)     MATERIALIZED if(type = 'event_msg' AND role = 'token_count', JSONExtract(raw, 'payload', 'rate_limits', 'secondary', 'window_minutes', 'Nullable(UInt64)'), NULL),

    INDEX idx_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_project project    TYPE set(1024)           GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(ts)
ORDER BY (machine, path, generation, byte_offset, content_hash)
SETTINGS non_replicated_deduplication_window = 10000, max_bytes_to_merge_at_max_space_in_pool = 1073741824, ttl_only_drop_parts = 1;
