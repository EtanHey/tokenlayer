# Telemetry store

One ClickHouse database `tokenlayer` on the M1 hub (`tailscale serve :8123`, tailnet only).
Apply the schema with `bun run schema:apply` (reads `CLICKHOUSE_*` from the environment; every file is idempotent).

| Table | Feed | Sort key | Engine |
|---|---|---|---|
| `proxy_usage` | `tokenlayer-drain` ← `GET /v8/management/observability/usage/queue` | `(credential, toDate(ts), ts, execution_id)` | ReplacingMergeTree, monthly partitions |
| `credentials_snap` | `tokenlayer-steer` (P3) | `(credential, ts)` | MergeTree, monthly partitions |
| `session_events` | `tokenlayer-ship` on each Mac | `(machine, path, generation, byte_offset)` | ReplacingMergeTree, monthly partitions |

Identity values never land in ClickHouse in the clear: `credential` = `labelHash(auth_index)`,
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
- Every persisted value (rows, spool, rejects, logged ClickHouse errors) passes the shared redactor
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

- Sources: `~/.claude/projects/**/*.jsonl` (includes `<session>/subagents/agent-*.jsonl`) and `~/.codex/sessions/**/*.jsonl`.
- `harness`: Claude files whose lines carry `entrypoint: "sdk-ts"` → `t3` (T3 drives Claude Code via the Agent SDK),
  otherwise `claude`. Codex files whose `session_meta.payload.originator` is `"T3 Code"` → `t3`, otherwise `codex`.
  A file whose head has no deciding line yet ships with the default and is reshipped once it is decided.
- A line is `(machine, path, generation, byte_offset)`. Generation starts as a SHA-256 identity of
  device, inode and birthtime. Rotation preserves the previous generation even with identical content.
  An in-place rewrite adds a revision hash to preserve archived rows.
- A write-ahead `<statePath>.generations` sidecar reserves each generation and its source fingerprint before
  insertion. Recovery retains the longest verified prefix while replaying earlier chunks, even through repeated
  crashes; progress checkpoints can lag without shortening archive protection. Keep it when resetting progress:
  checkpoint loss replays the current generation, and late harness
  classification preserves that generation. Losing both files loses the information needed to recover revisions;
  restore the sidecar from backup before replaying an archive with in-place rewrites.
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
- Stop all shippers before `bun run schema:apply`. Legacy session tables migrate through a copy and atomic
  exchange, retaining `session_events_legacy`. Missing generation values become `legacy`; missing message IDs
  become empty strings. Reapplying is safe; interrupted copies can leave physical duplicates collapsed by FINAL.
  The shipper checks the live schema before starting and refuses incompatible tables.
- A file failure is isolated until the end of the pass; acknowledged progress for other files is saved before
  the pass reports failure. All progress after intermediate saves is included in the final checkpoint.
- Each chunk is inserted with an `insert_deduplication_token` derived from its range and its row content, and the
  checkpoint advances only after ClickHouse confirms the insert. An identical retry is a server-side no-op; changed rows
  for the same range are a new insert.
- Replays with different chunk boundaries (for example after a lost checkpoint) insert duplicate rows that only a
  background merge collapses. Read `session_events` with `FINAL` (as the queries below do) for counts and sums.
- `raw` (and every parsed column) is the line after the shared redactor (`src/lib/redact.ts`): the JSON is parsed,
  redacted deeply and re-serialised; an invalid line is redacted as text. `line_bytes` and offsets refer to the
  original file.
- Token columns are credited once per API response: Claude repeats `message.usage` on every content-block line of a
  message (credited on the first line per `message.id`); Codex `token_count.last_token_usage` is credited unless the
  running total is unchanged, and `token_usage_record` lines (same numbers) are not credited.
  `input_tokens` means uncached input for both harnesses (Codex `input_tokens - cached_input_tokens`).
- The daemon picks up un-checkpointed files only if modified in the last 24 h; `--backfill [--since DATE]` does history
  at `--rate-mb` (default 5 MB/s).
- Not shipped yet: T3 Code's own thread store (SQLite, see the PR-b body) and the stray Codex rollout at `~/.t3/*.jsonl`.

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

Activity per machine / harness / project (provenance histories; legacy upgrade replays can double counts and
token sums even with `FINAL`):

```sql
SELECT machine, harness, project, toDate(ts) AS day,
       uniqExact(session_id) AS sessions, count() AS events,
       sum(output_tokens) AS output_tokens
FROM tokenlayer.session_events FINAL
WHERE ts >= now() - INTERVAL 30 DAY
GROUP BY machine, harness, project, day
ORDER BY day DESC, events DESC
```
