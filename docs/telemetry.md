# Telemetry store

One ClickHouse database `tokenlayer` on the M1 hub (`tailscale serve :8123`, tailnet only).
Apply the schema with `bun run schema:apply` (reads `CLICKHOUSE_*` from the environment; every file is idempotent).

| Table | Feed | Sort key | Engine |
|---|---|---|---|
| `proxy_usage` | `tokenlayer-drain` ← `GET /v8/management/observability/usage/queue` | `(credential, toDate(ts), ts, execution_id)` | ReplacingMergeTree, monthly partitions |
| `credentials_snap` | `tokenlayer-steer` (P3) | `(credential, ts)` | MergeTree, monthly partitions |
| `session_events` | `tokenlayer-ship` on each Mac | `(machine, path, generation, byte_offset, content_hash)` | ReplacingMergeTree, monthly partitions |

Drain identity columns use hashes: `credential` = `labelHash(auth_index)`,
`account_hash` = `labelHash(source)` (email / project / upstream key), `client_key_hash` = `labelHash(api_key)`.
`labelHash` is `sha256("tokenlayer:v1:" + value)[:16]` (`src/lib/hash.ts`), shared by steer so the tables join.

## Drain guarantees

- The usage queue is destructive on read and keeps items for `redis-usage-queue-retention-seconds` (300 on the hub),
  so the drain polls every 15 s and pages with `?count=1000` until a short page.
- Every popped page is fsynced to `~/.local/state/tokenlayer/drain/spool.ndjson` before any insert. A batch leaves the
  spool only after ClickHouse confirms the insert (below). Each batch carries a fixed `insert_deduplication_token`, and the table has
  `non_replicated_deduplication_window`, so a retry after an ambiguous failure inserts nothing twice.
- Items that cannot be mapped go to `rejects.ndjson` with identity fields redacted. Nothing is dropped silently.
- Malformed pages retain only a byte count and SHA-256 receipt through the ordinary reject deep redactor.
  Raw bodies are never retained, including non-array JSON and encoded strings.
- Drain proxy_usage rows and their spool preserve telemetry text and public rate-limit
  header values without ingest redaction or failure-body truncation. Identity columns
  remain hashed. Rejected records and error egress retain sanitization.
- Egress (rejects, logs, stderr, thrown errors and usage.json) passes the shared redactor
  (`src/lib/redact.ts`). It removes known API/OAuth key prefixes, JWTs, PEM private keys and emails;
  bearer tokens of at least 8 characters (including letters-only tokens); URL userinfo with a password;
  and values named by sensitive fields, regardless of the value's prefix. Field matching covers camelCase,
  snake_case and hyphenated names, including env prefixes ending in `_PASSWORD`, `_KEY`, `_TOKEN` or `_SECRET`.
  Text assignments accept single/double quotes and escaped JSON quotes; CLI flags accept `--password x`
  and `--token=x`, including escaped spaces and adjacent quoted segments in one argument. JSON string
  escapes are decoded before scanning their content, so encoded line endings separate env lines while
  literal backslash+n/r bytes remain part of the secret. Authorization, Cookie, Set-Cookie and X-*-Key
  header values are removed in full.
  Structured numeric values and ordinary usage fields are preserved. This is shape-based sanitization,
  not a guarantee for arbitrary unlabeled secrets, encoded payloads or unknown credential formats.
- An insert counts as acknowledged only when ClickHouse confirms it: `wait_end_of_query=1`, no
  `X-ClickHouse-Exception-Code` header and no exception in the body. HTTP 200 alone is not trusted.
- Known gap: if the process dies between the HTTP pop and the spool fsync, that page is lost (milliseconds wide).
- If a Redis-protocol subscriber is attached to the hub's usage channel, CLIProxyAPI publishes to it *instead of*
  queueing (`internal/redisqueue/queue.go` `Enqueue`). Nothing in this setup subscribes; keep it that way.

## Shipper guarantees (`tokenlayer-ship`)

- Sources: `~/.claude/projects/**/*.jsonl` (includes `<session>/subagents/agent-*.jsonl`) and `~/.codex/sessions/**/*.{jsonl,jsonl.zst}` (including T3-origin Codex rollouts).
- Compressed Codex rollouts require `zstd` on the shipper's PATH (`brew install zstd` on macOS).
  Check the daemon's actual PATH before deployment. If unavailable, each pass emits one sanitized warning,
  skips compressed files without changing their progress checkpoints or generation journal, and continues
  shipping plain files. The daemon stays running; compressed files retry when `zstd` becomes available.
  Decode uses `zstd -qdc -- PATH` with backpressure and checked exit status. Bun 1.4.4's
  `node:zlib.createZstdDecompress` accepted a truncated frame in the fixture probe, so it is not used.
  The first streaming pass validates the entire file before inserts and verifies any recorded decoded prefix;
  a second streams batches. No full-file memory buffer or decoded disk copy is made. Batch buffers are bounded by
  the larger of the budget (capped at 64 MiB) and one line, plus a pipe chunk; decoded lines above 64 MiB fail before insertion.
  Offsets, content hashes, raw bytes and the rate cap use decoded coordinates. Verification reads are additional I/O.
- `.jsonl.zst` maps to the logical `.jsonl` path. Its verified old prefix reuses the plain-file generation,
  including existing inode-derived v3 generations. Keep both progress state and the `.generations` journal:
  compression and later materialization back to plain can change the inode without changing replacement keys.
  An unseen compressed rollout uses the first 16 hex digits of its complete decoded SHA-256 as generation.
  Rewrites that do not match the protected prefix retain the existing revision rules and archive variants.
  Compressed checkpoints also record compressed size, SHA-256, mtime/ctime and successful completion;
  unchanged completed containers skip decode, changed containers replay. Decode failures report a sanitized path
  and a content-free reason, leave existing checkpoints intact and do not block other files in the pass.
- There is no automatic migration for lost lineage: if both state files are absent and the old plain inode is gone,
  its old generation cannot be reconstructed from compressed content. Restore the journal before replay; otherwise
  pause backfill and reconcile the logical path's existing generations using an operator-approved occurrence/hash
  export before importing. Do not silently replay under a new generation and claim unique counts.
  Archaeology's `shipperCovers(.zst)` remains false until this reader is deployed and the collab's F-3 replay/coverage
  prerequisites are satisfied; installing source alone must not suppress historical recovery.
- `harness`: Claude files whose lines carry `entrypoint: "sdk-ts"` → `t3` (T3 drives Claude Code via the Agent SDK),
  otherwise `claude`. Codex files whose `session_meta.payload.originator` is `"T3 Code"` → `t3`, otherwise `codex`.
  A file whose head has no deciding line yet ships with the default and is reshipped once it is decided.
  Harness is a file-level column, excluded from generation identity so late classification and state loss
  do not duplicate lines. On a returning inode whose head was rewritten in place, `harness` may change
  for unchanged archived lines when they are replayed.
- A line is `(machine, path, generation, byte_offset, content_hash)`: the full SHA-256 covers exact source
  bytes including LF (and CR if present), before decoding. Different content cannot replace an archive
  even if generation/offset recur. Generation tracks device/inode/birthtime and rewrite lineage, not archive safety.
- A write-ahead `<statePath>.generations` sidecar reserves each generation and its source fingerprint before
  insertion. Recovery retains the longest verified prefix while replaying earlier chunks, even through repeated
  crashes; progress checkpoints can lag without shortening archive protection. Keep it when resetting progress:
  checkpoint loss replays the current generation, and late harness
  classification preserves that generation. Losing both files loses revision lineage and can add replay rows;
  content hashes still protect different archived content. Restore the sidecar to retain lineage.
- Version 3 checkpoints hash the entire acknowledged prefix using streaming 64 KiB buffers. Changed files
  verify that prefix before resuming; batch hashes extend incrementally, avoiding a full rehash per chunk.
  The verified prefix hash is reused to extend batches from their exact source buffers before insertion;
  checkpoint hashes never come from a post-acknowledgement path read. A rewrite additionally hashes the current
  file to derive its revision. The 5 MB/s setting caps shipped
  bytes; verification reads are additional local disk I/O. Unchanged files skip reads.
- v1/v2 state upgrades atomically to v3 by discarding incompatible checkpoints and replaying files once.
  A durable replay list keeps previously tracked files eligible even under the daemon's 24-hour cutoff and
  across startup or insert failures. Old content-based generations remain archived; counts and token sums
  across that upgrade can include both histories even with `FINAL`, and do not represent unique source lines.
- Stop all shippers before `bun run schema:apply`: copy/atomic exchange retains `session_events_pre_content_hash`
  and any earlier `session_events_legacy`. Missing generation/message IDs become `legacy`/empty. Historical bytes
  are unavailable: missing hashes use `legacy:` plus SHA-256 of the stored column tuple except `ingested_at` and `harness`.
  The copy retains physical stored-content variants and applies the old FINAL harness winner to each old key.
  This separate namespace preserves stored variants; replays can add rows. Already replaced history is unrecoverable.
  Before copying, schema apply queries active session-table bytes and free ClickHouse disk space, refusing
  free space below twice the active bytes. Budget roughly 2–3x storage plus merge headroom.
  Reapplying after success is safe. An existing scratch/archive table blocks a new migration; after a crash,
  keep `session_events_hash_next` and inspect whether EXCHANGE completed before any manual recovery.
  Retain both archives until counts, stored-content variants and late harness winners are verified and an
  external backup is confirmed. Then an operator may run `DROP TABLE tokenlayer.session_events_pre_content_hash`
  and, if present, `DROP TABLE tokenlayer.session_events_legacy`. They have no TTL; schema apply never drops them.
  Startup checks the full key and column types and refuses incompatible tables.
- A file failure is isolated until the end of the pass; acknowledged progress for other files is saved before
  the pass reports failure. All progress after intermediate saves is included in the final checkpoint.
- Each chunk is inserted with an `insert_deduplication_token` derived from its range and its row content, and the
  checkpoint advances only after ClickHouse confirms the insert. An identical retry is a server-side no-op; changed rows
  for the same range are a new insert.
- Replays with different chunk boundaries (for example after a lost checkpoint) insert duplicate rows that only a
  background merge collapses. Read `session_events` with `FINAL` for archive counts; use the context view for attributed, credited sums.
- `raw` is the exact source line, including LF and any CR, without reserialization or ingest redaction.
  Blank lines are skipped; an unterminated trailing line waits for LF.
  Every parsed column is a pure function of that line: absent text is empty, absent/invalid time is Unix epoch,
  and token columns retain each line's reported usage. File history, birthtime and earlier message IDs cannot
  change an unchanged line's archived columns. The archive is byte-exact per line, including invalid UTF-8 bytes;
  parsed columns use UTF-8 decoding while raw bytes bypass decoding during insertion.
  This supersedes the previous line-exact and redacted contract. Historical redacted rows cannot recover text.
- `v_session_events_context` derives inherited session/cwd/project/model/time and usage credit at query time,
  exposing `(session_id, ordinal)` (ordinal is unique within the session across archive identities).
  Attribution windows stay within `(machine, path, generation)` and order by byte offset/content hash.
  Multiple content variants at one offset sort by hash; the view does not reconstruct an original revision's
  sequence. Derived values/ordinals can change as archive variants arrive. Historical migrated parsed values
  remain historical receipts; they are not reparsed or claimed to have the new line-local semantics.
  This view credits tokens once per API response: Claude repeats `message.usage` on every content-block line of a
  message (credited on the first line per `message.id`); Codex `token_count.last_token_usage` is credited unless the
  running total is unchanged, and `token_usage_record` lines (same numbers) are not credited.
  `input_tokens` means uncached input for both harnesses (Codex `input_tokens - cached_input_tokens`).
- The daemon picks up un-checkpointed files only if modified in the last 24 h; `--backfill [--since DATE]` does history
  at `--rate-mb` (default 5 MB/s).
- Not shipped yet: T3 Code's own thread store (SQLite, see the PR-b body) and the stray Codex rollout at `~/.t3/*.jsonl`.

Agents default to `v_session_events_meta` (an explicit metadata allowlist) and `v_requests`
(request metadata without failure bodies/codes, headers, endpoint, IP or user agent). These views
are query conveniences, not access controls. Raw text needs an explicit query on the base table.

## Example queries

Burn per account per day:

```sql
SELECT credential, toDate(ts) AS day,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_write,
       countIf(failed) AS failures
FROM tokenlayer.proxy_usage FINAL
WHERE ts >= now() - INTERVAL 7 DAY
GROUP BY credential, day
ORDER BY day DESC, credential
```

Cache read/write ratio per session (is session affinity keeping the cache warm?):

```sql
SELECT session_id, any(credential) AS first_credential, uniqExact(credential) AS credentials_used,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_write,
       round(cache_read / greatest(cache_write, 1), 2) AS read_per_write
FROM tokenlayer.proxy_usage FINAL
WHERE session_id != '' AND ts >= now() - INTERVAL 1 DAY
GROUP BY session_id
ORDER BY cache_write DESC
LIMIT 50
```

Activity per machine / harness / project: the context view reads the archive with `FINAL` and derives attribution/usage credit.
Rewound/abandoned branches with different content remain distinct. Legacy migration or lineage loss can increase sums:

```sql
SELECT machine, harness, project, toDate(ts) AS day,
       uniqExact(session_id) AS sessions, count() AS events,
       sum(output_tokens) AS output_tokens
FROM tokenlayer.v_session_events_context
WHERE ts >= now() - INTERVAL 30 DAY
GROUP BY machine, harness, project, day
ORDER BY day DESC, events DESC
```
