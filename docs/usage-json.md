# Keyless usage snapshot (M4)

The launch agent runs `src/usage/main.ts` every 60 seconds. BatchMode SSH to `m1`
sources the management key on M1 and performs a read-only credentials GET. The key
never enters the M4 environment or filesystem. Remote stderr and exception text
are discarded. The remote shell builtin printf pipes the Authorization header to
curl with `-H @-`; the key never appears in curl argv and no header file is created. The only published error is `hub unavailable`.

`~/.config/tokenlayer/usage.json` contains Claude OAuth accounts only. Labels are
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
Stale projection preserves the rollover marker but remains unusable for admission.
Snapshot freshness describes collection time; unexpired utilization still comes
from passive last-response headers, not a new upstream usage probe.
Active means highest priority among healthy accounts, then earliest weekly reset,
five-hour reset and credential ID, matching steer's tie order.

On failure, previous accounts and timestamp survive with stale=true and a fixed error.
Before any successful retrieval the timestamp is null and accounts empty. Consumers
must check stale. Writes use an exclusive temporary file, chmod 644 and atomic rename.
SSH connects within 10 seconds and has an overall subprocess deadline of 25 seconds.

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
