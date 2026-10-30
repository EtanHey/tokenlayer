-- Context reads session_events FINAL. F-1 native ids remain distinct from parent aliases.
-- A session active on several days/models counts once in each corresponding group (UTC).
CREATE OR REPLACE VIEW tokenlayer.v_sessions_daily AS
SELECT toDate(ts) AS day, project AS repo, model, harness, machine, uniqExact(session_id) AS sessions
FROM tokenlayer.v_session_events_context
WHERE model != '' AND session_id != '' AND ts > toDateTime64(0, 3, 'UTC')
GROUP BY day, repo, model, harness, machine;
