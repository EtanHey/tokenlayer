# tokenlayer

Sidecars around a self-hosted [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub, following
[Theo's hub guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af):

- **steer** — soonest-reset-first routing without forking the proxy: reads each credential's captured
  rate-limit reset times from the management API and moves the account that resets soonest to the top priority tier.
- **drain** — persists the proxy's per-request usage records (tokens, cache reads/writes, account, latency) to ClickHouse.
- **ship** — ships Claude Code, Codex and T3 Code session JSONL from every machine into the same ClickHouse.

No secrets live in this repo. See `config/cliproxyapi.conf.template`.

Archaeology currently supports dry-run and throwaway validation only; no apply mode exists.
Its CLI requires `--existing EXPORT.tsv`, even for a dry-run. The export must describe what
ClickHouse actually holds after `FINAL`, with columns `machine`, `session_id`, `path` (or `stream`),
`generation`, `content_hash`, and `count`. Use the native stream owner for `session_id`, including
rows without an inline id; retain subagent stream identity. A header-only export means the server
is empty. Missing exports and malformed headers fail closed.

Each `count` is per **(machine, stream, path, generation, content_hash)**. Never sum occurrences
across paths or generations: coverage uses the maximum per stream/hash within one machine.
Local live files are candidates, not evidence of server coverage: an uncheckpointed file older
than 24 hours may have been skipped without shipper `--backfill`. Uncovered live lines are included
in the import projection and deduplicated against archive copies. The library's optional export
supports conservative fixture projections with zero assumed server coverage; any future apply
must require a fresh server export and recheck the disk gate (at least 35 GiB real free after import).

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

The restore command is intended for either Mac with the same ClickHouse configuration.
CLI execution has been verified on M1; M4 source files were only hashed read-only over SSH.

```sh
./bin/tokenlayer session restore <session_id> --to ~/session-restores
# Disambiguate copies or rewrites with --machine m1 --path /original/file.jsonl --generation <id>
```

This reads `~/.config/tokenlayer/clickhouse.env` (or `TOKENLAYER_ENV_FILES` / process env).
It discovers native ids and aliases, then reads **all** lines of one `(machine, path, generation)`
from `tokenlayer.session_events FINAL`, ordered by byte offset. It decodes `hex(raw)` to preserve
non-UTF-8 bytes and checks every source hash, byte length, LF terminator and contiguous offset.
Missing sessions, multiple identities, gaps, overlaps, conflicts and unverifiable legacy rows fail.
The query result is capped at 64 MiB (including hex encoding); oversized queries fail without an export.

Each invocation creates a new private directory containing `session.jsonl` and `receipt.json`
(mode 600; directory 700). The default parent is `~/.local/share/tokenlayer/restores`.
Unredacted archive data stays in these files; stdout prints `file=`, SHA-256, counts and scope.
Destinations inside Git worktrees must be gitignored before writing. Existing restores are untouched.

The receipt certifies an **archived contiguous prefix**, with `sourceComplete: "unknown"`:
there is no source EOF manifest, LF-only blank lines were skipped by the shipper, and unterminated
source tails were never shipped. Internal missing bytes cause rejection; missing trailing bytes cannot
be detected. A full original-file comparison is needed to claim full-file exactness. This command
exports a snapshot; it does not install provider history, resume an agent, or modify T3/BrainLayer.
