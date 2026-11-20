-- UTC days, observed completed turns only. Kiro Free: 50 credits per monthly billing cycle.
-- Source (checked 2026-11-03): https://kiro.dev/docs/billing/ . Account cycle boundary is not logged.
-- daily_allowance_used_pct is that day's credits / 50, not a remaining-balance estimate.
-- Quota columns are peaks of observed rolling gauges across accounts/limits, NOT daily burn.
-- Memory (R5, 2026-11-19): raw stays out of every FINAL read. raw is the same in every version of a key (content_hash
-- is its SHA-256) and FINAL keeps every key, so raw-only facts are read without FINAL and joined by stream or key.
CREATE OR REPLACE VIEW tokenlayer.v_provider_usage_compare AS
WITH streams AS (
    SELECT machine, path, generation,
        multiIf(kiro_lines > 0, 'kiro',
                antigravity_lines > 0 OR created_at_lines, 'antigravity',
                codex_lines > 0, 'codex',
                claude_lines > 0 OR message_lines, 'claude', '') AS provider
    FROM (
        SELECT machine, path, generation,
               countIf(startsWith(type, 'kiro:')) AS kiro_lines, countIf(harness = 'antigravity') AS antigravity_lines,
               countIf(harness = 'codex' OR type IN ('session_meta', 'event_msg', 'turn_context')) AS codex_lines,
               countIf(harness = 'claude') AS claude_lines
        FROM tokenlayer.session_events FINAL
        GROUP BY machine, path, generation
    ) AS parsed
    LEFT JOIN (
        SELECT machine, path, generation, max(JSONHas(raw, 'created_at')) AS created_at_lines, max(JSONHas(raw, 'message')) AS message_lines
        FROM tokenlayer.session_events
        GROUP BY machine, path, generation
    ) AS raw_flags USING (machine, path, generation)
), token_totals AS (
    SELECT toDate(ts) AS day, provider,
           sumOrNull(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
    FROM tokenlayer.v_session_events_context INNER JOIN streams USING (machine, path, generation)
    WHERE provider IN ('claude', 'codex', 'antigravity') AND ts > toDateTime64(0, 3, 'UTC')
    GROUP BY day, provider
    UNION ALL
    -- Jev calls go straight to api.typesafe.ai, so they come from the ledger drain, not the hub or sessions.
    SELECT toDate(ts) AS day, 'typesafe' AS provider, sumOrNull(toUInt64(input_tokens)) AS tokens
    FROM tokenlayer.systemone_calls FINAL GROUP BY day
), typesafe_daily AS (
    SELECT toDate(ts) AS day, sumOrNull(cost_usd) AS cost_usd FROM tokenlayer.systemone_calls FINAL GROUP BY day
), kiro_turns AS (
    -- Raw archive revisions survive rewrites. A native turn must contribute once across revisions.
    SELECT argMax(tuple(ts, credits), tuple(ingested_at, byte_offset, content_hash)) AS latest
    FROM tokenlayer.session_events FINAL
    WHERE type = 'kiro:usage_summary' AND session_id != '' AND ts > toDateTime64(0, 3, 'UTC')
    GROUP BY machine, session_id, if(message_id = '', content_hash, message_id)
), kiro_daily AS (
    SELECT toDate(latest.1) AS day,
           sumOrNull(latest.2) AS credits_used, countIf(isNull(latest.2)) AS unknown_kiro_turns
    FROM kiro_turns GROUP BY day
), codex_readings AS (
    -- Native Codex token_count logs carry rate_limits. Window size must match the column.
    SELECT toDate(ts) AS day, primary_pct, primary_minutes, secondary_pct, secondary_minutes
    FROM (
        SELECT machine, path, generation, byte_offset, content_hash, ts
        FROM tokenlayer.session_events FINAL
        WHERE type = 'event_msg' AND role = 'token_count' AND ts > toDateTime64(0, 3, 'UTC')
    ) AS final_counts
    ANY LEFT JOIN (
        SELECT machine, path, generation, byte_offset, content_hash,
               JSONExtract(raw, 'payload', 'rate_limits', 'primary', 'used_percent', 'Nullable(Float64)') AS primary_pct,
               JSONExtract(raw, 'payload', 'rate_limits', 'primary', 'window_minutes', 'Nullable(UInt64)') AS primary_minutes,
               JSONExtract(raw, 'payload', 'rate_limits', 'secondary', 'used_percent', 'Nullable(Float64)') AS secondary_pct,
               JSONExtract(raw, 'payload', 'rate_limits', 'secondary', 'window_minutes', 'Nullable(UInt64)') AS secondary_minutes
        FROM tokenlayer.session_events
        PREWHERE type = 'event_msg' AND role = 'token_count'
    ) AS limits USING (machine, path, generation, byte_offset, content_hash)
), quota_peaks AS (
    -- Claude gauges are the hub's per-response rate-limit headers, stored by the drain.
    SELECT toDate(ts) AS day, 'claude' AS provider,
           maxOrNull(if(u5h BETWEEN 0 AND 1, u5h * 100, NULL)) AS peak_5h_used_pct,
           maxOrNull(if(u7d BETWEEN 0 AND 1, u7d * 100, NULL)) AS peak_weekly_used_pct
    FROM (SELECT ts, toFloat64OrNull(ratelimit['anthropic-ratelimit-unified-5h-utilization']) AS u5h,
                 toFloat64OrNull(ratelimit['anthropic-ratelimit-unified-7d-utilization']) AS u7d
          FROM tokenlayer.proxy_usage WHERE provider = 'claude')
    GROUP BY day
    UNION ALL
    SELECT day, 'codex' AS provider,
           maxOrNull(greatest(if(primary_minutes = 300 AND primary_pct BETWEEN 0 AND 100, primary_pct, NULL),
                              if(secondary_minutes = 300 AND secondary_pct BETWEEN 0 AND 100, secondary_pct, NULL))),
           maxOrNull(greatest(if(primary_minutes = 10080 AND primary_pct BETWEEN 0 AND 100, primary_pct, NULL),
                              if(secondary_minutes = 10080 AND secondary_pct BETWEEN 0 AND 100, secondary_pct, NULL)))
    FROM codex_readings GROUP BY day
), days AS (
    SELECT day FROM token_totals UNION DISTINCT SELECT day FROM kiro_daily UNION DISTINCT SELECT day FROM quota_peaks
    UNION DISTINCT SELECT toDate(ts) AS day FROM tokenlayer.session_events FINAL
                   WHERE startsWith(type, 'kiro:') AND ts > toDateTime64(0, 3, 'UTC')
    UNION DISTINCT SELECT day FROM typesafe_daily
)
SELECT day, provider, tokens, if(provider = 'kiro', credits_used, NULL) AS credits_used,
       if(provider = 'kiro', unknown_kiro_turns, CAST(NULL, 'Nullable(UInt64)')) AS unknown_kiro_turns,
       if(provider = 'kiro', 50., NULL) AS allowance_credits,
       if(provider = 'kiro', credits_used * 2, NULL) AS daily_allowance_used_pct,
       peak_5h_used_pct, peak_weekly_used_pct,
       -- Kiro has no measured tokens. Other providers' rolling gauges do not measure UTC-day burn.
       CAST(NULL, 'Nullable(Float64)') AS tokens_per_1pct_allowance,
       if(provider = 'typesafe', cost_usd, NULL) AS cost_usd,
       multiIf(provider = 'kiro', 'Known-credit subtotal. See unknown_kiro_turns for missing telemetry. No token counters or balance logged. Not full account usage. Monthly cycle start unknown.',
               provider = 'antigravity', 'Tokens only. No allowance percentage source.',
               provider = 'typesafe', 'Jev (Typesafe /v1/systemone) direct calls from usage.jsonl ledgers. Tokens are reconciled input tokens. cost_usd is the ledger net and keeps the held maximum for unreconciled calls.',
               'Quota percentages are observed daily peaks across accounts/limits, not daily burn. Tokens per allowance percent is unknown.') AS note
FROM (SELECT day, arrayJoin(['kiro', 'codex', 'claude', 'antigravity', 'typesafe']) AS provider FROM days) AS grid
LEFT JOIN token_totals USING (day, provider)
LEFT JOIN kiro_daily USING (day)
LEFT JOIN quota_peaks USING (day, provider)
LEFT JOIN typesafe_daily USING (day);
