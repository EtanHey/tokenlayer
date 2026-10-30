# tokenlayer-steer

Soonest-reset-first routing on an unforked CLIProxyAPI. The hub runs `routing.strategy: fill-first` with session
affinity. Every 60s steer reads `GET /v8/management/credentials` and sets per-credential `priority`. The selector only
uses the highest available tier, and a larger value wins.

| Credential | Priority |
|---|---|
| Healthy Claude Max OAuth whose 7d window resets soonest (5h reset breaks ties) | 100 (alone) |
| Every other Claude Max OAuth (including unhealthy ones and ones with no signals yet) | 50 |
| Claude API key | 0, always |
| Any other provider | untouched |

A credential is **not promotable** when it is disabled, in `error`, `unavailable`, or has `next_retry_after` or a
cooldown in the future. The same applies when its 7d, 5h or representative unified window says `rejected` or shows
utilization ≥ 1. A window whose reset time has passed is stale, so its status is ignored and its reset counts as
unknown. Unknown is not soon: a credential with no reset signal is never promoted, but it stays at 50, so it remains
eligible. If no Max credential is healthy, all of them sit at 50 and fill-first plus failover does the rest.

Bound sessions are not moved by a re-rank. In config.example.yaml's routing section: "An established binding outranks
credential priority … Credential priority still decides cold bindings, requests without a session, and post-failover
rebinding."

## Run

```sh
bun src/steer/main.ts --once --dry-run   # GET only: log what it would PATCH
bun src/steer/main.ts --snapshots        # loop; one credentials_snap JSON row per credential per tick on stdout
```

Env comes from `TOKENLAYER_ENV` (default `~/.config/tokenlayer/hub.env`); the process env wins.
Variables: `CLIPROXY_MGMT_KEY`, `TOKENLAYER_HUB_URL` (default `http://127.0.0.1:8317`), `TOKENLAYER_HUB` (default
`m1`), `TOKENLAYER_STEER_INTERVAL_MS`. A log line is written only for a change or an error. The credential is shown as
`labelHash(auth_index)`, the same `credential` value P4 writes to `proxy_usage`.

launchd: render `launchd/com.tokenlayer.steer.plist` (`__BUN__`, `__REPO__`, `__HOME__`) into `~/Library/LaunchAgents`.

## How priority is written

**API path (implemented).** `PATCH /v8/management/credentials/fields {"name": <id>, "priority": N}`. The handler
writes `priority` into the credential metadata and syncs the `priority` attribute that the selector reads. It commits
through `Manager.Modify`, which persists the auth JSON, so the value survives a restart. Priority 0 deletes the
attribute, but GET can return numeric `0` from metadata or null/missing; steer treats all as 0.
Source: `internal/api/handlers/management/auth_files_fields.go:422,751-753` and
`internal/api/handlers/management/auth_files.go:755-765`.

**File path (designed, not built; fallback only).** On the hub, rewrite `~/.cli-proxy-api/<file>.json` with a
top-level `"priority"`. Write a temp file in the same directory with the same mode, then `rename`; the watcher
hot-reloads it in about 4s. This would force steer onto the hub and race the proxy's own token-refresh writes to the
same file (read-modify-write could drop a fresh token). That is why the API path is used.

## Seeding an idle account's reset signals (not built)

`quota.signals` are passive: they are captured from the last upstream response. No client request header pins a
request to a credential. The internal pin (`pinned_auth_id`) is set only by plugin model callbacks and Codex websocket
sessions. The management `POST /v8/management/requests/api-call` takes an `auth_index`, but it does not update
`quota.signals`, and it would use the subscription outside Claude Code, so it is ruled out. The viable option is a
**priority flip**: for one tick, put the no-signal account alone at 100 so that the next cold Claude Code session lands
on it and records its headers.

Failed GETs and ticks with PATCH/snapshot errors use exponential backoff with up to 25% jitter,
capped at five minutes. Retry-After (seconds or HTTP date) is honoured up to that cap.
Failure delays begin after the tick finishes; a clean tick restores the configured interval.

PATCH failures back off independently per credential (120 s, 240 s, then 300 s,
honoring Retry-After up to the cap). Other credentials retain the configured tick
interval. Successful PATCHes clear their backoff; removed credentials are pruned.
GET and snapshot failures still back off the whole loop. A one-shot PATCH failure
returns a nonzero exit status. Backoff state is in memory per hub client.
