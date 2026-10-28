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
- Every persisted value (rows, spool, rejects, logged ClickHouse errors) passes the shared deep redactor
  (`src/lib/redact.ts`): API keys, bearer/OAuth tokens, JWTs, private keys, auth-file JSON and emails become `[redacted]`.
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
- A line is `(machine, path, generation, byte_offset)`. `generation` is the file's identity on disk,
  `sha256(dev:ino:birthtimeNs, rewrites)[:16]`: a file rotated or re-created at the same path is a new generation even
  when its first line is the same, and so is each rewrite (truncation or in-place edit) detected in the same file.
  The earlier generation's rows stay as archived history and are never overwritten. Re-reading the same file (retry,
  late harness decision, lost checkpoint of a never-rewritten file) maps to the same generation, so its rows replace
  rather than duplicate. Known limit: a lost checkpoint forgets the rewrite count, so rereading a rewritten file
  replaces the rows of its first generation.
- Checkpoints live in `~/.config/tokenlayer/ship-state.json` (v3: identity, mtime, offset, a hash per 1 MiB block of
  the shipped range, rewrite count, generation, parser carry-forward). Only `\n`-terminated lines ship; a partial last
  line waits. A file with unchanged size, identity and mtime (and no sweep in progress) is skipped without reading.
- Rewrite detection: any change re-checks the first and last block at once and starts a sweep that re-verifies 4 MiB
  of blocks per file per pass, cycling, until one full sweep has passed since the last change (even if the file has
  gone idle). An edit anywhere before the offset is therefore caught within `ceil(shipped / 4 MiB)` passes, while a
  pass never reads more than 6 MiB of an active file to check it. Verified bytes count against `--rate-mb`. A
  full rehash on every change was rejected: a 100 MB session appended every 10 s would need 10 MB/s of reads, twice the
  budget, for one file. A new identity, a shorter file, or a block mismatch restarts the file from 0.
- v1 and v2 state files are upgraded in place: a checkpoint whose file still matches (same inode, old fingerprint)
  resumes at its offset with its old generation (`""` for v1, matching the migrated #1-era rows); any other restarts
  that file. An unrecognised state file stops the daemon with the exact command to move it aside.
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

Activity per machine / harness / project:

```sql
SELECT machine, harness, project, toDate(ts) AS day,
       uniqExact(session_id) AS sessions, count() AS events,
       sum(output_tokens) AS output_tokens
FROM tokenlayer.session_events FINAL
WHERE ts >= now() - INTERVAL 30 DAY
GROUP BY machine, harness, project, day
ORDER BY day DESC, events DESC
```
