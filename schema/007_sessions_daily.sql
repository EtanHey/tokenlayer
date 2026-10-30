-- Context reads session_events FINAL. F-1 native ids remain distinct from parent aliases.
-- A session active on several days/models counts once in each corresponding group (UTC).
-- Only sessions with no non-empty model in that day's group count under (none).
CREATE OR REPLACE VIEW tokenlayer.v_sessions_daily AS
SELECT day, repo, arrayJoin(if(empty(models), ['(none)'], models)) AS model, harness, machine, uniqExact(session_id) AS sessions
FROM (
    SELECT toDate(ts) AS day, project AS repo, harness, machine, session_id,
           groupUniqArrayIf(model, model != '') AS models
    FROM tokenlayer.v_session_events_context
    WHERE session_id != '' AND ts > toDateTime64(0, 3, 'UTC')
    GROUP BY day, repo, harness, machine, session_id
)
GROUP BY day, repo, model, harness, machine;
