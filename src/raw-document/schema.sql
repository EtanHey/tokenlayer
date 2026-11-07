-- Review-only DDL: deliberately outside schema/ and automatic schema:apply.
CREATE TABLE {database:Identifier}.raw_documents
(
    contract_version UInt8,
    revision_id String,
    acquisition_id String,
    custody_machine String,
    source_locator String,
    origin_machine String,
    original_path String,
    origin_proof String,
    format String,
    format_version String,
    historical_writer_version String,
    original_hash String,
    original_bytes UInt64,
    acquisition_method String,
    observed_at String,
    acquisition_receipt_hash String,
    raw String,
    CONSTRAINT raw_length CHECK length(raw) = original_bytes,
    CONSTRAINT raw_hash CHECK lower(hex(SHA256(raw))) = original_hash
)
ENGINE = ReplacingMergeTree
ORDER BY (revision_id, acquisition_id)
SETTINGS non_replicated_deduplication_window = 1000;
