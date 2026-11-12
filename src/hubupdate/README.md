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
endpoints with changed counters, newly appearing endpoints or disappeared endpoints.
Command, parse and hub PID failures produce `busy_unknown`; raw diagnostics stay private.
Only positively attributed sidecar PIDs are ignored; every other peer is a normal client.
Version equality produces `up_to_date` unless a signal is unknown; inspect `idle.verdict` separately.

A stream silent for the entire window looks idle. Arrivals after the final sample are unseen.
Connections starting and ending between samples can be missed. Unattributed clients participate
in the counter comparison and remain counted in JSON. This is observation data, never restart authorization.

Refresh failures leave the version read running and report `refresh` as `ok`, `failed` or `skipped`.
`brew update` has a 120-second timeout; other commands retain 15 seconds.
Command failures expose only a fixed step token and `timed_out` or `nonzero` kind in `refreshError`, `versionError` or `idle.commandError`.
