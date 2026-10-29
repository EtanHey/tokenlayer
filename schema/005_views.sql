-- Agent defaults contain metadata only. Raw text requires an explicit base-table query.
CREATE OR REPLACE VIEW tokenlayer.v_session_events_meta AS
SELECT machine, harness, path, generation, byte_offset, content_hash, line_bytes, ts,
       session_id, project, cwd, type, role, model, message_id, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, reasoning_tokens, ingested_at
FROM tokenlayer.session_events FINAL;

-- All selected request columns exist in schema/002_proxy_usage.sql.
CREATE VIEW IF NOT EXISTS tokenlayer.v_requests AS
SELECT ts, execution_id, request_id, trace_id, hub, credential, account_hash, client_key_hash,
       provider, executor_type, auth_type, model, alias, response_model, session_id, parent_session_id,
       node_kind, is_fork, is_compaction, input_tokens, uncached_input_tokens, cache_read_tokens,
       cache_creation_tokens, cached_tokens, output_tokens, reasoning_tokens, total_tokens,
       accounting_version, accounting_quality, latency_ms, ttft_ms, status_code, failed, stream,
       reasoning_effort, service_tier, effective_service_tier, ingested_at
FROM tokenlayer.proxy_usage FINAL;
