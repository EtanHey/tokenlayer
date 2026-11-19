-- One row per Jev call (Typesafe /v1/systemone, called directly at api.typesafe.ai, never through the hub),
-- drained by src/jev from the jev.py usage.jsonl ledgers on each Mac. Sorts before 009, whose
-- v_provider_usage_compare reads it. Reads that count calls need FINAL: a lost drain state re-inserts
-- identical rows, and a late reconciliation re-inserts its call, until a background merge collapses them.
-- The ledger has 8 fields today. Columns from endpoint down to state_sha256 stay NULL until jev.py
-- writes them (golems lane 3). Never store the raw state, only its SHA-256.
CREATE TABLE IF NOT EXISTS tokenlayer.systemone_calls
(
    ts                     DateTime64(3, 'UTC')   CODEC(Delta, ZSTD(3)),
    reservation_id         String,
    machine                LowCardinality(String),
    ledger_path            String                 CODEC(ZSTD(3)),
    site                   LowCardinality(String),
    model                  LowCardinality(String),
    response_model         LowCardinality(Nullable(String)),
    reserved_at            Nullable(DateTime64(3, 'UTC')),
    reconciled_at          Nullable(DateTime64(3, 'UTC')),
    input_tokens           Nullable(UInt32),
    reserved_input_tokens  Nullable(UInt32),
    reserved_cost_usd      Nullable(Float64),
    reconcile_cost_usd     Nullable(Float64),
    -- Ledger net: reservation plus reconciliation. An unreconciled call keeps the held maximum.
    cost_usd               Float64,
    -- measured | reserved_max (jev.py booked 64k: no usage returned) | unreconciled | orphan_reconciliation
    accounting_quality     LowCardinality(String),
    endpoint               LowCardinality(Nullable(String)),
    mode                   LowCardinality(Nullable(String)),
    source                 LowCardinality(Nullable(String)),
    status_code            Nullable(UInt16),
    fail_code              LowCardinality(Nullable(String)),
    latency_ms             Nullable(UInt32),
    question_ids           Array(String),
    answer                 Nullable(String),
    confidence             Nullable(Float64),
    session_id             Nullable(String),
    parent_session_id      Nullable(String),
    thread_id              Nullable(String),
    state_sha256           Nullable(String),
    ingested_at            DateTime64(3, 'UTC')   DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY reservation_id
SETTINGS non_replicated_deduplication_window = 10000;
