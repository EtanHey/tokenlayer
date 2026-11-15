# Hub update

## `check` (report only)

`bin/tokenlayer hubupdate check [--idle-window 300] [--samples 3] [--refresh]`
measures client connections on port 8317 even when installed and available versions match.
Only `--refresh` runs `brew update`; this command never upgrades, links or restarts the hub.
One JSON line and an atomic mode-600 state file contain versions, decision, time and idle counts.
Override the default `~/.config/tokenlayer/hubupdate.json` with `TOKENLAYER_HUBUPDATE_STATE`.

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

## `run` (upgrade when idle; off by default)

`bin/tokenlayer hubupdate run [--target target.json]` upgrades the hub from Homebrew when all of these hold:
Homebrew stable is newer than the linked keg, that version is not recorded as failed, `brew update` succeeded
in this run, no upgrade succeeded in the last 24 hours, the running process is the linked keg, and the idle gate
passed. Otherwise it records the reason (`up_to_date`, `version_failed`, `refresh_failed`, `rate_limited`,
`running_mismatch`, `busy`, `busy_unknown`, `halted`, `locked`, `interrupted_run_pending`).

**Enable switch.** Off unless `~/.config/tokenlayer/hubupdate.enabled` contains exactly `enabled`. Off is a full
dry run: no fetch, upgrade, link, copy or restart; it records `would_upgrade_now` or the reason not. The launchd
template never creates the file.

**Idle gate.** `GET /v8/management/observability/requests/in-flight` (CLIProxyAPI >= 8.0.70, management key) must
read `in_flight: 0` on every poll (2 s) of a 20 s window; a non-zero poll restarts the window; a run waits up to
4 minutes for one. Timeout, non-200/404 status, malformed body or a missing key is `busy_unknown` at once. A 404
(hub older than 8.0.70) falls back to the `check` OS signal with 10 samples over 30 s per attempt. A second, short
gate (4 s, or 4 samples over 6 s) runs after `brew upgrade` and right before the restart; if busy, the old keg is
relinked, nothing restarts, and the version is not marked failed (`aborted_busy`).

**Steps** (each is written to the state journal before it starts):
`saving` (config and plist copied 0600, old keg copied with `ditto`, all under a 0700 backup folder) ->
`upgrading` (`brew upgrade --formula <formula>` with `HOMEBREW_NO_INSTALL_CLEANUP`, `HOMEBREW_NO_AUTO_UPDATE`,
`HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK`; then the new keg must be linked and config/plist byte-identical) ->
`rechecking` -> `restarting` (`launchctl kickstart -k gui/<uid>/<label>`, then a new listener PID) ->
`verifying` (the listener's executable resolves to `<cellar>/<formula>/<new>/`) -> `probing` (a real Claude Code
request through the hub: `claude --bare --setting-sources "" -p --model claude-haiku-5-5 --output-format json`
with `ANTHROPIC_BASE_URL` = the hub and `ANTHROPIC_API_KEY` = the access key; the single `result` event must be
`subtype: success`, `is_error: false`). Only then is the run recorded as `upgraded`.

**Rollback** (any failure after `saving`): restore the old keg from the backup if Homebrew removed it, `brew unlink`,
remove the new keg directory, `brew link` (one keg left, so it links the old one), check `brew info` agrees
(linked = old, new not installed), restart only if the running executable is not the old keg, then the same probe.
The failed version is recorded and never retried automatically. A failed rollback, or a changed config/plist,
sets `halted`; every later run refuses until a person clears it from the state file.

**Interruption.** A run that finds a journal (killed run, machine restart) never upgrades in that run. Killed while
`saving`: the partial backup is discarded. Any later step: the rollback above runs, and the version is recorded
as failed with `interrupted_at_<step>`. Dry-run mode only reports `interrupted_run_pending`.

**State.** `~/.config/tokenlayer/hubupdate-run/` (0700): `state.json` (0600, fsynced, atomic), `run.lock`,
`backups/<id>/`. To retry a failed version or clear a halt, edit `failed` / `halted` in `state.json` by hand.

**Target file.** Every hub-specific value (formula, launchd label, port, process name, config and plist paths,
hub URL, env file and key names, probe command, state dir, enable file, timings) has the live hub as default and
can be overridden from a JSON file, which is how the stand-in rehearsal ran the same code.

**Schedule.** The launchd template runs `run` every 30 minutes (`StartInterval` 1800); it is not installed.

**Restart facts (measured on a stand-in agent and read-only on the hub's agent).** `launchctl kickstart -k`
sends SIGTERM, then SIGKILL 5 s later (`exit timeout = 5` on both agents). Claude Code retries a refused
connection: a request that started while the port was closed succeeded once it reopened 8 s later; with the
port closed for good it gave up after about 3 minutes (`api_error: connection_failed`).

**Not done here: `server.shutdown-timeout`** (CLIProxyAPI >= 8.0.69, default 0 = close at once). A positive
value makes SIGTERM drain in-flight HTTP requests for that many seconds, then close. With the Homebrew plist's
5 s exit timeout, launchd sends SIGKILL at 5 s, so a value above about 4 s would be cut short. It would cover
requests that arrive between the last idle poll and SIGTERM; hijacked WebSocket connections are not drained.
