-- One row per upstream request served by the CLIProxyAPI hub, drained from
-- GET /v8/management/observability/usage/queue by tokenlayer-drain.
-- Identity values (account, upstream key, client key) are stored only as label hashes.
CREATE TABLE IF NOT EXISTS tokenlayer.proxy_usage
(
    ts                     DateTime64(3, 'UTC')   CODEC(Delta, ZSTD(3)),
    execution_id           String                 CODEC(ZSTD(3)),
    request_id             String                 CODEC(ZSTD(3)),
    trace_id               String                 CODEC(ZSTD(3)),
    hub                    LowCardinality(String),
    credential             LowCardinality(String),
    account_hash           LowCardinality(String),
    client_key_hash        LowCardinality(String),
    provider               LowCardinality(String),
    executor_type          LowCardinality(String),
    auth_type              LowCardinality(String),
    model                  LowCardinality(String),
    alias                  LowCardinality(String),
    response_model         LowCardinality(String),
    endpoint               LowCardinality(String),
    session_id             String                 CODEC(ZSTD(3)),
    parent_session_id      String                 CODEC(ZSTD(3)),
    node_kind              LowCardinality(String),
    is_fork                Bool,
    is_compaction          Bool,
    input_tokens           UInt64                 CODEC(T64, ZSTD(3)),
    uncached_input_tokens  UInt64                 CODEC(T64, ZSTD(3)),
    cache_read_tokens      UInt64                 CODEC(T64, ZSTD(3)),
    cache_creation_tokens  UInt64                 CODEC(T64, ZSTD(3)),
    cached_tokens          UInt64                 CODEC(T64, ZSTD(3)),
    output_tokens          UInt64                 CODEC(T64, ZSTD(3)),
    reasoning_tokens       UInt64                 CODEC(T64, ZSTD(3)),
    total_tokens           UInt64                 CODEC(T64, ZSTD(3)),
    accounting_version     UInt8,
    accounting_quality     LowCardinality(String),
    latency_ms             UInt32                 CODEC(T64, ZSTD(3)),
    ttft_ms                UInt32                 CODEC(T64, ZSTD(3)),
    status_code            UInt16,
    failed                 Bool,
    fail_code              LowCardinality(String),
    fail_body              String                 CODEC(ZSTD(6)),
    stream                 Bool,
    reasoning_effort       LowCardinality(String),
    service_tier           LowCardinality(String),
    effective_service_tier LowCardinality(String),
    client_ip              LowCardinality(String),
    user_agent             LowCardinality(String),
    ratelimit              Map(LowCardinality(String), String) CODEC(ZSTD(3)),
    ingested_at            DateTime64(3, 'UTC')   DEFAULT now64(3) CODEC(Delta, ZSTD(3)),

    INDEX idx_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_model   model      TYPE set(256)            GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
-- Per-account/day burn is a prefix scan; execution_id makes the dedupe key unique per request.
ORDER BY (credential, toDate(ts), ts, execution_id)
SETTINGS non_replicated_deduplication_window = 10000;
