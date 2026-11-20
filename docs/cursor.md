# Cursor native transcripts

The ship daemon scans `~/.cursor/projects` (override `TOKENLAYER_CURSOR_DIR`) for
`<encoded-workspace>/agent-transcripts/<id>/<id>.jsonl`. It ignores other JSONL
files and uses harness `cursor`, including sessions launched through T3.

Workspace resolution first matches the encoded directory against T3 project
`workspace_root` and thread `worktreePath` metadata from
`~/.t3/userdata/statev2.sqlite` (override `TOKENLAYER_CURSOR_T3_STATE`). The DB is
opened read-only and no message text is selected. Duplicate encodings remain
unknown. Without a registry match, conventional `Users-<user>-Gits-<repo>` roots
resolve to `/Users/${USER}/Gits/${REPO}`; this fallback cannot disambiguate nested
folders from hyphens. Other layouts retain empty cwd/project rather than invent
paths. The registry is refreshed each ship pass.

The parser inspects only top-level role and optional timestamp. Native records
observed on 20 November contain only role and message: model and all five token
fields are explicitly NULL, never quota percentages or the selected `default`
model. Undated rows use the archive's Unix epoch sentinel, not filesystem mtime
as a claimed event time. Existing 30-day replay retention applies; epoch rows
remain exempt under the established retention rule. Pickup age still uses mtime.

Like Claude/Codex/Kiro, `raw` stores the **complete original source line bytes**,
including message content and its LF/CRLF terminator. This is an exact archive,
not a metadata-only raw projection. Content hashes and byte offsets refer to
those exact bytes. Parser metadata extraction does not traverse message values;
normal egress redaction still protects diagnostics. Tests use invented identities
and empty text; no real transcript text or secrets are committed.

The existing archive had nonnullable model/token columns. Before installing this
shipper, stop shippers and apply the schema: these six columns become nullable
through guarded MODIFY COLUMN statements, with existing values preserved. Type
conversion may rewrite stored parts: assess cost under the M1 lock at rollout. This
change does not install, apply schema or backfill automatically. Real ClickHouse
migration and installed-daemon verification remain rollout gates.
