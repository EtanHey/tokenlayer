# tokenlayer

tokenlayer is a set of small background services around a self-hosted
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub on Etan's M1 Pro.
The hub handles model requests from coding tools on several Macs.
tokenlayer records requests, session logs, and account usage in one place.

## What it does

- `src/steer` gives priority to the available Claude account whose weekly limit
  resets soonest. The 5-hour reset breaks ties.
- `src/drain` saves a row per proxied request in ClickHouse `proxy_usage`, with the
  model, token counts, cache reads and writes, account hash, latency, and auth type
  (subscription or API key).
- `src/ship` uploads Claude Code, Codex, T3 Code, Antigravity, and Kiro session logs from
  each Mac into ClickHouse `session_events`.
- `src/usage` writes each Claude account's 5-hour and weekly usage to
  `~/.config/tokenlayer/usage.json` for other tools to read.
- `src/hubupdate` reports Homebrew versions and sampled hub activity without upgrading
  or restarting anything. See the [check command](src/hubupdate/README.md).

Usage tracking is telemetry only. It never blocks, slows, or pauses an agent.

## Is there a UI?

No. UI planned. There are no screenshots because there is no UI today.
You read the data with SQL. The `tokenlayer.v_sessions_daily` view counts sessions
per day, repo, and model. [Telemetry docs](docs/telemetry.md) explain the tables
and how to run queries from a Mac.

## Example query

Sessions per day by repo and model:

```sql
SELECT day, repo, model, sum(sessions) AS sessions
FROM tokenlayer.v_sessions_daily
WHERE day >= today()-30
GROUP BY day, repo, model
ORDER BY day DESC, sessions DESC
```

Example output with made-up numbers, repos, and models:

```text
day         repo          model            sessions
2026-10-31  example-app   example-model-a   12
2026-10-31  example-tool  example-model-b   4
```

Days are UTC. A session that uses several models counts once under each model.

## Restore a session

The restore command is intended for either Mac with the same ClickHouse configuration.
CLI execution has been verified on M1; M4 source files were only hashed read-only over SSH.

```sh
./bin/tokenlayer session restore <session_id> --to ~/session-restores
# Disambiguate copies or rewrites with --machine m1 --path /original/file.jsonl --generation <id>
```

This reads `~/.config/tokenlayer/clickhouse.env` (or `TOKENLAYER_ENV_FILES` / process env).
It discovers native ids and aliases, then reads **all** lines of one `(machine, path, generation)`
from `tokenlayer.session_events FINAL`, ordered by byte offset. It decodes `hex(raw)` to preserve
non-UTF-8 bytes and checks every source hash, byte length, LF terminator and contiguous offset.
Missing sessions, multiple identities, gaps, overlaps, conflicts and unverifiable legacy rows fail.
The query result is capped at 64 MiB (including hex encoding); oversized queries fail without an export.

Each invocation creates a new private directory containing `session.jsonl` and `receipt.json`
(mode 600; directory 700). The default parent is `~/.local/share/tokenlayer/restores`.
Unredacted archive data stays in these files; stdout prints `file=`, SHA-256, counts and scope.
Destinations inside Git worktrees must be gitignored before writing. Existing restores are untouched.

The receipt certifies an **archived contiguous prefix**, with `sourceComplete: "unknown"`:
there is no source EOF manifest, LF-only blank lines were skipped by the shipper, and unterminated
source tails were never shipped. Internal missing bytes cause rejection; missing trailing bytes cannot
be detected. A full original-file comparison is needed to claim full-file exactness. This command
exports a snapshot; it does not install provider history, resume an agent, or modify T3/BrainLayer.

## How it runs

The deploy scripts put ClickHouse and the usage recorder on the M1 Pro, alongside
the hub. Each Mac runs a session uploader that sends logs to that database.
The hub and database are reachable only through the tailnet, a private Tailscale
network shared by these Macs.

The LaunchAgent executables use these names for macOS Login Items:

- `tokenlayer session uploader` on each Mac.
- `tokenlayer database` on the M1 Pro.
- `tokenlayer usage recorder` on the M1 Pro.

## Setup

Follow the [deploy guide](docs/deploy-d1.md) and use the
[hub config template](config/cliproxyapi.conf.template).
Details live in the [steering](docs/steer.md), [usage snapshot](docs/usage-json.md),
[archaeology](docs/archaeology.md), [Antigravity capture](docs/antigravity.md),
and [Kiro capture and comparison](docs/kiro.md) docs.

## Rules

- Claude subscriptions are used only by Claude Code.
- Never enable cloaking or fingerprint modes.
- Keep the hub tailnet-only. Use `tailscale serve`, never `tailscale funnel`.
- Keep secrets outside the repo, in `~/.config/tokenlayer/*.env` with mode 600.
