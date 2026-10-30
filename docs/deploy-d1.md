# D1 deploy kit

Status: code kit only. No M1 deployment is claimed. Execute the M1 steps only after its reserved lane is released.
The operator needs the logged-in `happycampr` GUI domain on M1, Bun and Tailscale already installed, tailnet HTTPS enabled,
and the existing mode-600 `~/.config/tokenlayer/hub.env` with `CLIPROXY_MGMT_KEY`. Do not print that file.

## Ordered deployment

1. On M4, use the reviewed commit in a durable checkout (not a disposable T3 worktree). Stop any existing M4 shipper
   before schema migration: `launchctl bootout gui/$(id -u)/com.tokenlayer.ship` (absent service is normal).
   Transfer source without invoking M1 git/xcrun. Substitute the reviewed SHA:

   ```sh
   git archive <reviewed-SHA> | ssh m1 'mkdir -p ~/Gits/tokenlayer-d1; tar -x -C ~/Gits/tokenlayer-d1'
   ```

2. On M1 as `happycampr`, from `~/Gits/tokenlayer-d1`:

   ```sh
   export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
   bun install --frozen-lockfile
   scripts/deploy/setup.sh hub
   tailscale status --json
   tailscale serve status
   ```

   `hub` downloads/verifies the pinned official macOS arm64 binary (26.10.2.103, GitHub asset SHA256), generates a
   256-bit password once with `openssl rand`, stops local ship/drain, renders/bootstrap/kickstarts ClickHouse,
   waits for `/ping`, runs `bun run schema:apply`, then configures
   `tailscale serve --bg --https=8123 http://127.0.0.1:8123`. No git, brew, sudo or xcrun is used.
   This matches the hub's documented 127.0.0.1:8317 + Serve boundary; the repo has no captured live Serve mapping.
   Verify the pre-existing :8317 mapping remains unchanged. The setup never resets Serve or enables Funnel.
   Record `Self.DNSName` from status (trim its trailing dot); the M4 URL is `https://<DNSName>:8123`.

3. On M4, copy the password file without displaying it. Preserve an existing file and stop to reconcile if it differs;
   do not overwrite an existing credential. For a first deployment:

   ```sh
   umask 077
   mkdir -p ~/.config/tokenlayer
   ( set -o noclobber; ssh m1 cat .config/tokenlayer/clickhouse.env > ~/.config/tokenlayer/clickhouse.env )
   chmod 600 ~/.config/tokenlayer/clickhouse.env
   ```

   A failed transfer can leave an incomplete file: keep it and investigate before proceeding. The script refuses
   invalid credentials, symlinks, foreign ownership or a mode other than 600. Never paste or echo the password.

4. On each Mac, from its durable checkout, install sidecars and backfill:

   ```sh
   # M1 only (also installs drain, using existing hub.env):
   scripts/deploy/setup.sh ship m1
   scripts/deploy/backfill.sh --days 90 --rate-mb 2
   # M4 only; replace the placeholder with Self.DNSName from step 2:
   scripts/deploy/setup.sh ship m4 https://<DNSName>:8123
   scripts/deploy/backfill.sh --days 90 --rate-mb 2
   ```

   Run one backfill per Mac at a time. It uses `backfill-state.json` separately from the daemon's `ship-state.json`
   and retains both `.generations` sidecars. Stable source identity plus the replacement key and FINAL make replay
   safe; losing both progress and lineage, or copying source files to new inodes, can add archive histories.
   `--since` selects files by mtime, not individual event dates. The UTC cutoff is today minus N days; an eligible
   file may contribute older events. The 2 MiB/s cap applies to shipped bytes, with extra disk reads for verification.
   Logs are `~/Library/Logs/tokenlayer/backfill{,.err}.log` (replaced each invocation); daemon logs are adjacent.

## Verify and roll back

- Check `launchctl print gui/$(id -u)/com.tokenlayer.clickhouse` on M1, and `com.tokenlayer.ship` on both Macs;
  check `com.tokenlayer.drain` on M1. Confirm `/ping` and authenticated queries, and rejection of default/wrong passwords.
- On M1, `lsof -nP -iTCP -sTCP:LISTEN` must show ClickHouse only on 127.0.0.1:8123 and 127.0.0.1:19000.
  MySQL, PostgreSQL and interserver listeners must be absent. Inspect Serve status: only tailnet HTTPS for :8123.
- Run the query in [telemetry.md](telemetry.md#sessions-per-day-by-repo-and-model) from M4; verify both machines,
  dates and expected repos/models. Session counts alone do not prove compressed-history coverage.
- Rollback: stop backfill if running; on M4 boot out `com.tokenlayer.ship`; on M1 boot out ship, drain, then ClickHouse
  with `launchctl bootout gui/$(id -u)/<label>`. Disable only this route using `tailscale serve --https=8123 off` on M1.
  Keep data at `~/Library/Application Support/tokenlayer/clickhouse/`, credentials, progress/lineage, logs and binary.
  Keep rendered plists for inspection; bootout alone is temporary until login, so move them out of LaunchAgents if
  rollback must survive login. Rerun setup to restore. No data deletion is part of rollback.

## M4 metadata inventory

Measured 2026-10-30 03:22 UTC; cutoff 2026-08-01 03:22 UTC, last 90 elapsed days by file mtime. Only stat/listing;
no session contents read. Source family is the harness directory, not content-based T3 classification:

| Source | Extension | Files | Bytes |
|---|---|---:|---:|
| ~/.claude/projects (Claude + T3 Claude) | .jsonl | 9,695 | 11,204,645,903 |
| ~/.claude/projects | .jsonl.zst | 0 | 0 |
| ~/.codex/sessions (Codex + T3 Codex) | .jsonl | 2,909 | 6,059,242,032 |
| ~/.codex/sessions | .jsonl.zst | 4,391 | 9,130,147,205 |

The shipper accepts only `.jsonl`: **4,391 compressed Codex files / 9,130,147,205 bytes are excluded**. Route zstd
support separately; this PR does not implement it. T3-owned storage is outside these source roots: a metadata-only
scan of ~/.t3 (excluding worktrees/node_modules) found 1,078 .jsonl / 120,324,876 bytes, zero .jsonl.zst; these are
provider/triage/attachment artifacts, not proven sessions. No root-level ~/.t3/*.jsonl were found. T3's native
SQLite thread store is also not shipped. Exact `t3` harness counts require content inspection, outside this inventory.
