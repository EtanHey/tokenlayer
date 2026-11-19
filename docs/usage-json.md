# Keyless usage snapshot (M4)

The launch agent runs `src/usage/main.ts` every 60 seconds. BatchMode SSH to `m1`
sources the management key on M1 and performs a read-only credentials GET. The key
never enters the M4 environment or filesystem. Remote stderr and exception text
are discarded. The remote shell builtin printf pipes the Authorization header to
curl with `-H @-`; the key never appears in curl argv and no header file is created. The only published error is `hub unavailable`.

`~/.config/tokenlayer/usage.json` contains Claude OAuth accounts plus a `vendors` block (below). Labels are
`labelHash(auth_index || id)` from `src/lib/hash.ts`: 16 hex characters using the
shared `tokenlayer:v1:` domain prefix. The hub credential auth_index is preferred over
the filename (which may contain an email). Labels equal steer credentials_snap and
proxy_usage credential values, allowing direct joins. The prefix is public, not a
secret salt; this is pseudonymization, not protection against guessing known IDs.
Old eight-character labels are rejected on stale reload and replaced on the next
successful refresh. Raw identifiers,
emails and headers are excluded. All persisted strings pass through `redactDeep`.
Fractions become percentages; absent windows remain null. A known reset at or
before the collection time becomes `{used_pct:0,resets_at:null,rolled_over:true}`
for either window, unless the account or quota status is rejected. No new reset
time is fabricated. Status is rejected when steer blocks the account or a quota
status rejects it, allowed with utilization or rollover, otherwise unknown.
Stale projection preserves the rollover marker and remains marked stale.
Snapshot freshness describes collection time; unexpired utilization still comes
from passive last-response headers, not a new upstream usage probe.
Active means highest priority among healthy accounts, then earliest weekly reset,
five-hour reset and credential ID, matching steer's tie order.

On failure, previous accounts and timestamp survive with stale=true and a fixed error.
Before any successful retrieval the timestamp is null and accounts empty. Consumers
must check stale. Writes use an exclusive temporary file, chmod 644 and atomic rename.
SSH connects within 10 seconds and has an overall subprocess deadline of 25 seconds.

## Vendors (not on the hub)

`vendors.{codex,cursor,antigravity,kiro}` come from the provider caches T3 Code refreshes
about once a minute (`~/.t3/caches/<instance>.json` → `usageLimits`), read on every run,
hub or no hub. Each has `pct` (the fullest window; on a tie, the one that resets last),
`window`, `resets_at`, `observed_at`, `source` (`t3-cache:<instance>`), `stale` and
`windows[]`. Only numbers, timestamps and short window ids are copied. `stale` is true
when the observation is over 10 minutes old, the binding reset has passed, or there are
no numbers; then the numbers are null and `last_error` says why. Kiro's cache carries no
usage at all (status, auth, version and models only), so `vendors.kiro` stays null with a
`note` listing the cache's top-level key names.

### Counted use (`vendors.<v>.use`)

Antigravity and Kiro publish no quota, so `vendors.{antigravity,kiro,codex}.use` counts
what the shippers recorded in `tokenlayer.session_events`. Each run reads it once, bounded
to the last 7 days, capped at 2 GB and 20 seconds; on 19 Nov the read took 0.15 s and 0.3 GB.
The address and the capped `tokenlayer` login come from `~/.config/tokenlayer/ship.env` and
`clickhouse.env`, which the M4 already has for ship. The writer never falls back to a default store.

`use` has `observed_at`, `source` (`clickhouse:session_events`), and `24h` and `7d` windows.
Each window has:

- `sessions`: session files.
- `requests`: model responses. These are Antigravity planner responses, Kiro assistant messages and Codex `token_count` events.
- `input_tokens` and `output_tokens`: Antigravity and Codex only. Kiro rows carry none, so they are null.
- `credits`: Kiro only. This is the sum of known `usage_summary` credits; it is null when no turn reported any.

A vendor is matched by session path: `/.kiro/`, `antigravity`, `/.codex`. That covers native
and T3-run sessions alike. A replayed line or a later revision of the same Kiro turn counts once,
at its latest value. Cursor sessions are not shipped, so `vendors.cursor` has no `use`. On any
failure, `use` is `{observed_at: null, source, last_error: "store unavailable"}`.

## M4 installation

Build with `bun build --target=bun src/usage/main.ts --outfile ~/.config/tokenlayer/bin/usage.js`.
Create the bin directory first. Render `__HOME__` and `__BUN__` (absolute Bun path)
in `launchd/com.tokenlayer.usage.plist.template` into
`~/Library/LaunchAgents/com.tokenlayer.usage.plist`. Create `~/Library/Logs/tokenlayer/`.
Run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenlayer.usage.plist`.
No worktree is needed at runtime. Replace the bundle atomically for updates.
Stop using `launchctl bootout gui/$(id -u)/com.tokenlayer.usage`.

Verify two successful timestamps more than 60 seconds apart and mode 644. Scan the
file and log for email/auth markers and compare the key prefix on M1 without printing
or transferring it. Never paste raw credentials responses into logs or reports.

## Weekly and Fable projections

Accounts also publish `weekly_pct`, `weekly_status`, `weekly_resets_at`,
`fable_pct`, `fable_status`, `fable_resets_at`, and `observed_at` (weekly observation).
`weekly_observed_at` and `fable_observed_at` distinguish each passive observation.
Percentages use 0–100 with one decimal of precision; missing values remain null.
Fable comes specifically from `model_quotas["claude-fable-5-2"]` and its `7d_oi` headers.

`usage-history.jsonl`, beside the snapshot, retains two hours of content-free,
hashed-account observations. Duplicate observation timestamps do not add samples.
`burn_weekly_pct_per_hour` and `burn_fable_pct_per_hour` use the first and last
distinct observations within the last hour, requiring at least 15 minutes.
A reset change or utilization decrease starts a new series. Positive burn projects
`projected_weekly_empty_at` and `projected_fable_cap_at`; otherwise they are null.
The top-level `projection` identifies this linear method. Projection uses observation
time rather than poll time and is an estimate, not a promised exhaustion time.
Consumers must check `stale` and observation ages. An outage preserves validated
published fields and marks the snapshot stale; it does not invent observations.
