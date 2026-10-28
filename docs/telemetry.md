# Telemetry store

One ClickHouse database `tokenlayer` on the M1 hub (`tailscale serve :8123`, tailnet only).
Apply the schema with `bun run schema:apply` (reads `CLICKHOUSE_*` from the environment; every file is idempotent).

| Table | Feed | Sort key | Engine |
|---|---|---|---|
| `proxy_usage` | `tokenlayer-drain` ← `GET /v8/management/observability/usage/queue` | `(credential, toDate(ts), ts, execution_id)` | ReplacingMergeTree, monthly partitions |
| `credentials_snap` | `tokenlayer-steer` (P3) | `(credential, ts)` | MergeTree, monthly partitions |
| `session_events` | `tokenlayer-ship` on each Mac | `(machine, harness, path, byte_offset)` | ReplacingMergeTree, monthly partitions |

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
FROM tokenlayer.session_events
WHERE ts >= now() - INTERVAL 30 DAY
GROUP BY machine, harness, project, day
ORDER BY day DESC, events DESC
```
