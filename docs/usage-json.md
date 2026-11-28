# Keyless usage snapshot (M4)

The launch agent runs `src/usage/main.ts` every 60 seconds. BatchMode SSH to `m1`
sources the management key on M1 and performs a read-only credentials GET. The key
never enters the M4 environment or filesystem. Remote stderr and exception text
are discarded. The remote shell builtin printf pipes the Authorization header to
curl with `-H @-`; the key never appears in curl argv and no header file is created. The only published error is `hub unavailable`.

`~/.config/tokenlayer/usage.json` contains Claude OAuth accounts plus a `vendors` block (below). Labels are
`labelHash(auth_index || id)` from `src/lib/hash.ts`: 16 hex characters using the
shared `tokenlayer:v1:` domain prefix. The hub credential auth_index is preferred over
the filename (which may contain an email). Labels equal steer and
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
five-hour reset and credential ID, matching steer's tie order, provided the account
has a fresh observation. A stale winner is cleared; another account is not nominated
as a routing recommendation.

Each published account adds `stale`, `observation_age_s` and `last_status`.
`ACCOUNT_STALE_MS` is five minutes: five 60-second writer cycles and twenty
15-second drain cycles, matching the dashboard's existing Claude freshness bound.
The newest valid `observed_at`, `weekly_observed_at` or `fable_observed_at` determines
age in seconds. More than five minutes old, missing, or future-dated means
`stale: true`, `status: "stale"` and `active: false`. Unknown age is null.
`last_status` retains the last raw derived status (`allowed`, `rejected`, `unknown`).
Percentages and individual window timestamps remain available as historical readings;
a fresh Fable observation does not make an old weekly reading fresh. Readers using
a particular window must still check that window's observation time.

The top-level shape and whole-snapshot `stale` retain their existing meaning.
On failure, previous accounts and timestamp survive with top-level stale=true and a
fixed error; per-account ages are recomputed at publication time, including when
loading a snapshot from before these additive fields existed.
Before any successful retrieval the timestamp is null and accounts empty. Consumers
must check stale. Writes use an exclusive temporary file, chmod 644 and atomic rename.
SSH connects within 10 seconds and has an overall subprocess deadline of 25 seconds.

## Vendors (not on the hub)

`vendors.{codex,cursor,antigravity,kiro}` come from the provider caches T3 Code refreshes
about once a minute (`~/.t3/caches/<instance>.json` → `usageLimits`), read on every run,
hub or no hub. Each has `pct` (the fullest window; on a tie, the one that resets last),
`window`, `resets_at`, `observed_at`, `source` (`t3-cache:<instance>`), `stale` and
`windows[]`. Only numbers, timestamps and short window ids are copied. `stale` is true
when the observation is over 10 minutes old, more than one minute in the future,
or the binding reset has passed. These stale readings retain their numbers without
`last_error`; consumers must gate those numbers on `stale`. Unavailable readings
have null numbers, `stale: true` and a fixed `last_error`. Kiro's cache carries no
usage at all (status, auth, version and models only), so `vendors.kiro` stays null with a
`note` listing the cache's top-level key names.

### Counted use (`vendors.<v>.use`)

Counted use complements vendor quota readings: `vendors.{antigravity,kiro,codex}.use` counts
what the shippers recorded in `tokenlayer.session_events`. Recent events are bounded
to the last 7 days. Codex additionally looks behind that boundary for the first
observation of cumulative usage on those same machine/path identities, so a refresh
cannot re-credit an older response. The query caps reads at 20 million rows and
8 GB, memory at 2 GB and execution at 20 seconds (client timeout: 25 seconds).
Cap failures remain unavailable; the writer never retries uncapped. The historical
0.15 s / 0.3 GB measurement predates logical crediting and does not qualify this query.
The address and the capped `tokenlayer` login come from `~/.config/tokenlayer/ship.env` and
`clickhouse.env`, which the M4 already has for ship. These use standard dotenv syntax (the native
`node:util` parser): quote values containing `#` or whitespace; `clickhouse.env`
overrides `ship.env`. The writer never falls back to a default store.

`use` has `observed_at`, `source` (`clickhouse:session_events`), and `24h` and `7d` windows.
Each window has:

- `sessions`: session files.
- `requests`: model responses. These are Antigravity planner responses, Kiro assistant messages and Codex `token_count` events with real usage. Repeated cumulative totals and rate-limit-only refreshes contribute neither requests nor tokens.
- `input_tokens` and `output_tokens`: Antigravity and Codex only. Kiro rows carry none, so they are null.
- `credits`: Kiro only. This is the sum of known `usage_summary` credits; it is null when no turn reported any.

Vendor roots are `/.kiro/sessions/`, `/.gemini/antigravity-cli/brain/`,
`/.t3/userdata/providers/antigravity/` and `/.codex/sessions/` (including T3-run
Codex sessions). Similar words elsewhere in a path do not select a vendor. A replayed line or a later revision of the same Kiro turn counts once,
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

## Usage bundle budget (successor to #183)

Bun 1.4.3, unminified `target: bun`, against main `38747f4`:
main is 27,849 B; this successor is 31,251 B, a 3,402 B increase.
Main's growth=0.1 / allowance=2560 policy would permit 30,409 B,
so the remaining gap is 842 B. This PR discloses growth=0.125 /
allowance=3456, retaining #183's final allowance and giving a 31,305 B
limit with 54 B headroom against today's main.

Trimming the reviewed 31,905 B reader with native dotenv parsing,
native JSON decoding, shared vendor-root matching and a shared unavailable
projection saves 654 B. A generated aggregation/window projection was tried
and was larger. The remaining query handles exact replay, Kiro revisions,
canonical Codex totals and first observations before both window cuts;
removing those parts would break the refresh fixture. Getting below the
remaining allowance would require a broader writer rewrite, rather than
removing a redundant dependency from this reader. No query cap is raised.
The separate #203 tighten-back remains lead-owned; remeasure it after this
successor rather than treating these feature measurements as its proof.

## Readers in this repository

- `src/usage/main.ts` reloads the previous file during an outage through
  `src/usage/snapshot.ts`; that validator accepts the added fields and stale status,
  allowlists the raw status, and recomputes freshness rather than freezing ages.
- `src/dashboard/tools.ts` reads only `generated_at` and `vendors`, called by
  `src/dashboard/server.ts` and rendered by `src/dashboard/app.js` / `page.ts`.
  Claude dashboard readings come directly from the hub, with their own five-minute
  check; these surfaces do not consume `accounts` from usage.json.
- `ratchet/usage-age.ts`, dispatched by `ratchet/live.ts` for `usage_json_age_s`
  (`ratchet/rows.json`), checks collection age and top-level `stale`. Its 120-second
  ceiling measures writer health, independently of passive account observations.
- `scripts/after-merge-install.ts` reads collection age, top-level `stale` and the
  presence of `vendors` for installation verification. Account staleness is not a
  writer/install failure. Neither this check nor the ratchet needs a schema change.
- `tests/usage/{writer,vendors}.test.ts`, `tests/dashboard/tools.test.ts` and
  `tests/ratchet/usage-age.test.ts` exercise those file readers using fixtures.

Inventory: `rg -n 'usage\.json|usage_json_age_s'` (excluding ignored local files).
Other matches document the snapshot, or refer to unrelated Jev `usage.jsonl` ledgers.
