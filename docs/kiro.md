# Kiro usage capture and comparison

`TOKENLAYER_KIRO_DIR` defaults to `~/.kiro/sessions`. Only
`<workspace-hash>/<native-id>/messages.jsonl` is shipped. Native ID comes from the
session directory. Sibling `session.json` supplies `workspacePaths[0]` and `modelId`.
Model is the requested session model snapshot (e.g. `auto`), not verified actual
per-request routing. Rows use their ISO `timestamp` and `payload.type` (prefixed
`kiro:` in the archive).

Raw lines, including prompts, assistant replies and reasoning, agent notes and
tool output, are archived verbatim in ClickHouse `session_events.raw`, like
Claude/Codex. Kiro uses their shared `RAW_BYTES` serializer/archive path. That
path does not redact stored raw lines; diagnostic/error output is redacted.
This full-archive treatment was explicitly approved by orc for Kiro in review.

Observed on M4, 2026-11-03: one native Auto `reply OK` turn used about 0.06749
credits; one T3 Auto turn used about 0.08172. Both wrote the same native layout.
The T3 provider directory did not exist. `TOKENLAYER_KIRO_T3_STATE` defaults to
`~/.t3/userdata/statev2.sqlite`, read-only: table
`orchestration_v2_projection_provider_threads`, `driver='kiro'`,
`payload_json.nativeThreadRef.nativeId` identifies harness `t3`. Others use `kiro`.
Late bindings replay with the same replacement keys. Existing T3 attribution
survives removal of a binding. Missing DB/table means no known T3 bindings;
a database read error fails that file while other ship roots still run. Torn,
missing or partial `session.json` metadata preserves the last known cwd/model;
only non-empty replacement values update those fields.

Only `payload.type=usage_summary` carries credits: sum
`payload.promptTurnSummaries[].usage` where `.unit='credit'`; fractional values
are retained in `credits Nullable(Float64)`. `turnId` (fallback `executionId`)
identifies the turn. `requestIds[]` is recorded raw, not treated as a credit join.
Malformed/absent credit telemetry is NULL. Both real captures lacked token
counters and remaining/total balance. Archive token zeros are unmeasured; the
comparison shows Kiro tokens as NULL. Context `usagePercentage` is not quota use.
Legacy `~/Library/Application Support/kiro-cli/data.sqlite3` is not ingested: its
`user_turn_metadata.usage_info[].{value,unit,unit_plural}` has no verified timestamp
join. The IDE store and old empty `sessions/cli/*.jsonl` are not ingested.

After the lead applies the schema, query `tokenlayer.v_provider_usage_compare`.
It returns each UTC day and all four providers. Kiro credits deduplicate native
turns across retained revisions. At equal ingestion time, the later byte offset
wins over an earlier summary for the same turn. `credits_used` sums known turns;
`unknown_kiro_turns` counts summaries without usable credit telemetry. A partial
day keeps its known subtotal; an all-unknown day has NULL credits. Summing the raw
`session_events.credits` column directly can double count retained revisions.
The day's known credits divided by 50 gives that
day's percentage of a monthly allowance. [Kiro billing](https://kiro.dev/docs/billing/)
confirms Free=50 and renewal at the next billing cycle (checked 2026-11-03).
Account reset boundary and full-account coverage remain unknown.

Claude peaks come from `credentials_snap.utilization_5h/utilization_7d`, the
history behind local `usage.json`. Codex peaks come from native token_count
`payload.rate_limits.{primary,secondary}.{used_percent,window_minutes}` for
300-minute and 10080-minute windows only. Peaks span accounts/limits and are
rolling gauges, not daily consumption. Missing gauges are NULL. Antigravity is
tokens only. Tokens include input, output and cache tokens; reasoning is already
part of output. Tokens per 1% is NULL: Kiro has no tokens, and the other providers'
quota windows/account coverage do not match these daily token totals.

Deployment is a lead step: apply the schema before installing the updated shipper.
