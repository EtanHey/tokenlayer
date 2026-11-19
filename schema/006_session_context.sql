-- Query-time attribution only: archive columns remain pure functions of source-line bytes.
-- Session/ordinal addresses are derived; attribution windows stay within each archive identity.
-- FINAL merges per monthly partition: versions of a key never span partitions (see ratchet/live-sql.ts), so the
-- answer is identical and the merge skips the whole-table pass (pre-November read: p50 991 → 316 ms, 2026-11-19).
-- Memory: the stream windows sort only narrow columns, and with optimize_read_in_window_order (reader profile)
-- they read in table order without a sort. raw (51 GiB uncompressed) stays out of every window: the planner moved
-- the token_count JSON extraction above the sort, so the old view sorted raw and passed the 8 GiB cap even for
-- one day. Credit for message and token_count lines (~1.8M of 11M) is computed apart and joined after the windows.
-- raw is the same in every version of a key (content_hash is its SHA-256), so the totals are read without FINAL,
-- only from token_count lines (PREWHERE), and keyed to the FINAL rows. R5 receipt, 2026-11-19.
CREATE OR REPLACE VIEW tokenlayer.v_session_events_context AS
WITH token_lines AS (
    SELECT machine, path, generation, byte_offset, content_hash, message_id
    FROM tokenlayer.session_events FINAL
    WHERE type = 'event_msg' AND role = 'token_count'
    SETTINGS do_not_merge_across_partitions_select_final=1
), message_lines AS (
    SELECT machine, path, generation, byte_offset, content_hash, message_id
    FROM tokenlayer.session_events FINAL
    WHERE message_id != ''
    SETTINGS do_not_merge_across_partitions_select_final=1
), credits AS (
    -- A message is credited on its first line in the stream.
    SELECT machine, path, generation, byte_offset, content_hash,
           row_number() OVER (PARTITION BY machine, path, generation, message_id ORDER BY byte_offset, content_hash) = 1 AS credit
    FROM message_lines
    UNION ALL
    -- A token_count line without a message id is credited when its cumulative total differs from the stream's
    -- previous token_count line. Every other line has an empty total, so only token_count lines are compared.
    SELECT machine, path, generation, byte_offset, content_hash, credit
    FROM (
        SELECT machine, path, generation, byte_offset, content_hash, message_id,
               token_total != lagInFrame(token_total, 1, '') OVER (PARTITION BY machine, path, generation ORDER BY byte_offset, content_hash
                                                                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS credit
        FROM token_lines
        ANY LEFT JOIN (
            SELECT machine, path, generation, byte_offset, content_hash,
                   coalesce(nullIf(JSONExtractRaw(raw, 'payload', 'info', 'total_token_usage'), ''), 'null') AS token_total
            FROM tokenlayer.session_events
            PREWHERE type = 'event_msg' AND role = 'token_count'
        ) AS totals USING (machine, path, generation, byte_offset, content_hash)
    )
    WHERE message_id = ''
), context AS (
    SELECT machine, harness, path, generation, byte_offset, content_hash, line_bytes, type, role, message_id,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, ingested_at,
        coalesce(anyLast(nullIf(session_id, '')) OVER w, path) AS context_session,
        coalesce(anyLast(nullIf(cwd, '')) OVER w, '') AS context_cwd,
        countIf(cwd != '') OVER (PARTITION BY machine, path, generation) AS recorded_cwds,
        coalesce(anyLast(nullIf(model, '')) OVER w, '') AS context_model,
        coalesce(anyLast(nullIf(ts, toDateTime64(0, 3, 'UTC'))) OVER w, toDateTime64(0, 3, 'UTC')) AS context_ts
    FROM tokenlayer.session_events FINAL
    WINDOW w AS (PARTITION BY machine, path, generation ORDER BY byte_offset, content_hash ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    SETTINGS do_not_merge_across_partitions_select_final=1
), credited AS (
    SELECT context.*, if(message_id != '' OR (type = 'event_msg' AND role = 'token_count'), credits.credit, true) AS credit
    FROM context LEFT JOIN credits USING (machine, path, generation, byte_offset, content_hash)
)
SELECT machine, harness, path, generation, byte_offset, content_hash, line_bytes,
       context_ts AS ts, context_session AS session_id,
       row_number() OVER (PARTITION BY context_session ORDER BY machine, path, generation, byte_offset, content_hash) AS ordinal,
       tokenlayer_repo(context_cwd, if(recorded_cwds = 0, path, '')) AS project,
       if(context_cwd != '', arrayElement(splitByChar('/', replaceRegexpOne(context_cwd, '/+$', '')), -1),
          if(recorded_cwds = 0, tokenlayer_project_slug(path), '')) AS cwd_basename,
       context_cwd AS cwd, type, role, context_model AS model, message_id,
       if(credit, input_tokens, 0) AS input_tokens, if(credit, output_tokens, 0) AS output_tokens,
       if(credit, cache_read_tokens, 0) AS cache_read_tokens, if(credit, cache_creation_tokens, 0) AS cache_creation_tokens,
       if(credit, reasoning_tokens, 0) AS reasoning_tokens, ingested_at
FROM credited;
