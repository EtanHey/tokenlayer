-- Query-time attribution only: archive columns remain pure functions of source-line bytes.
-- Session/ordinal addresses are derived; attribution windows stay within each archive identity.
CREATE OR REPLACE VIEW tokenlayer.v_session_events_context AS
WITH source AS (
    SELECT *, if(type = 'event_msg' AND role = 'token_count', coalesce(nullIf(JSONExtractRaw(raw, 'payload', 'info', 'total_token_usage'), ''), 'null'), '') AS token_total
    FROM tokenlayer.session_events FINAL
), context AS (
    SELECT *,
        coalesce(anyLast(nullIf(session_id, '')) OVER w, path) AS context_session,
        coalesce(anyLast(nullIf(cwd, '')) OVER w, '') AS context_cwd,
        coalesce(anyLast(nullIf(project, '')) OVER w, '') AS context_project,
        coalesce(anyLast(nullIf(model, '')) OVER w, '') AS context_model,
        coalesce(anyLast(nullIf(ts, toDateTime64(0, 3, 'UTC'))) OVER w, toDateTime64(0, 3, 'UTC')) AS context_ts,
        if(message_id != '', row_number() OVER (PARTITION BY machine, path, generation, message_id ORDER BY byte_offset, content_hash) = 1,
           token_total = '' OR token_total != coalesce(anyLast(nullIf(token_total, '')) OVER previous, '')) AS credit
    FROM source
    WINDOW w AS (PARTITION BY machine, path, generation ORDER BY byte_offset, content_hash ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
           previous AS (PARTITION BY machine, path, generation ORDER BY byte_offset, content_hash ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
)
SELECT machine, harness, path, generation, byte_offset, content_hash, line_bytes,
       context_ts AS ts, context_session AS session_id,
       row_number() OVER (PARTITION BY context_session ORDER BY machine, path, generation, byte_offset, content_hash) AS ordinal,
       context_project AS project, context_cwd AS cwd, type, role, context_model AS model, message_id,
       if(credit, input_tokens, 0) AS input_tokens, if(credit, output_tokens, 0) AS output_tokens,
       if(credit, cache_read_tokens, 0) AS cache_read_tokens, if(credit, cache_creation_tokens, 0) AS cache_creation_tokens,
       if(credit, reasoning_tokens, 0) AS reasoning_tokens, ingested_at
FROM context;
