# Hub update check (report only)

`bin/tokenlayer hubupdate check [--idle-window 300] [--samples 3] [--refresh]`
measures client connections on port 8317 even when installed and available versions match.
Only `--refresh` runs `brew update`; this command never upgrades, links or restarts the hub.
One JSON line and an atomic mode-600 state file contain versions, decision, time and idle counts.
Override the default `~/.config/tokenlayer/hubupdate.json` with `TOKENLAYER_HUBUPDATE_STATE`.
The launchd template schedules checks at 02:10, 03:10 and 04:10 local time; it is not installed.

At least three nettop snapshots span the window. lsof attributes each client endpoint;
launchctl PIDs for `com.tokenlayer.{drain,fable,ship,steer,usage,dashboard}` are ignored.
`seen`, `ignored` and `unattributed` count unique client endpoints across samples; `changed` counts non-ignored
endpoints with changed counters/owners, newly appearing endpoints or disappeared endpoints.
Command, parse, PID and attribution failures produce `busy_unknown`; raw diagnostics stay private.
Unattributed peers remain unknown while sampling continues and preserves known sidecar counts.
Version equality produces `up_to_date` unless a signal is unknown; inspect `idle.verdict` separately.

A stream silent for the entire window looks idle. Arrivals after the final sample are unseen.
Connections starting and ending between samples can be missed. Remote clients that lsof cannot
attribute produce `busy_unknown`. This is observation data, never restart authorization.
