-- Expanded by src/lib/schema.ts from the shared SESSION_RETENTION_DAYS constant.
-- Apply via bun run schema:apply. Metadata only; existing parts require separately announced, space-checked materialization.
ALTER TABLE tokenlayer.session_events MODIFY SETTING max_bytes_to_merge_at_max_space_in_pool = 1073741824, merge_with_ttl_timeout = 3600;
ALTER TABLE tokenlayer.proxy_usage MODIFY SETTING max_bytes_to_merge_at_max_space_in_pool = 1073741824;
ALTER TABLE tokenlayer.session_events MODIFY TTL toDateTime(ts) + INTERVAL {{SESSION_RETENTION_DAYS}} DAY DELETE WHERE harness != 'antigravity' AND toYYYYMM(ts) != 197001 SETTINGS materialize_ttl_after_modify = 0;
