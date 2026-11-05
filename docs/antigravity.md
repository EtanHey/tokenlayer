# Antigravity JSONL capture

Antigravity JSONL capture: `TOKENLAYER_ANTIGRAVITY_CLI_DIR` defaults to
`~/.gemini/antigravity-cli/brain`; `TOKENLAYER_T3_ANTIGRAVITY_DIR` defaults to
`~/.t3/userdata/providers/antigravity`. Only `brain/<native-id>/.system_generated/logs/transcript.jsonl`
layouts are shipped (T3 also requires `<provider>/antigravity-acp/`). Harnesses are `antigravity` and `t3`.
The conversation directory supplies the native session id: the observed transcript has no id field.
CLI cwd joins sibling `conversation_summaries.db` read-only on `conversation_id`, taking the first
`file://` entry in JSON `workspace_uris`; T3 uses sibling `conversations/<native-id>.meta.cwd`.
Missing metadata leaves cwd empty. The shared repo rules attribute it to `(other)`.
`created_at` supplies event time; missing/invalid times inherit the previous valid timestamp,
including across batches/restarts. Without an initial valid timestamp, that file fails closed.
`input_tokens`, `output_tokens`, and `cache_read_tokens` map directly; other token columns stay zero.
No model field was found in all 656 M4 transcripts, T3 `.meta` fields, or the summary table columns.
Model stays empty and `v_sessions_daily` displays `(none)`; `.meta.mode_id` is not treated as a model.
Opaque `raw_summary` protobuf blobs were not decoded, so actual-model attribution there is unverified.
Raw bytes, replacement keys, checkpoints and egress remain on the existing archive path.
Append-only behavior is unverified: prefix/identity changes retain revisions through generation logic;
the daily view counts each native session once per day/repo/model/harness/machine, across revisions.
Apply the schema before deployment to refresh `v_sessions_daily`. This capture does not ingest app SQLite payloads.
