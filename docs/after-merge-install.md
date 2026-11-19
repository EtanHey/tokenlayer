# After-merge install

One script installs a merged commit on both Macs, in the order the receipts need:

```sh
git fetch origin
bun scripts/after-merge-install.ts --commit <full sha on origin/main>            # dry run: reads, prints, changes nothing
bun scripts/after-merge-install.ts --commit <full sha on origin/main> --apply    # runs it
```

- `--commit` takes only a full or short lowercase hex SHA. It is resolved to the full commit with `git rev-parse --verify <sha>^{commit}` before any script is built, the dry run included; anything else exits 2 having run nothing. The SHA, the stamp and the ClickHouse path enter the bash on both Macs single-quoted.
- It runs from the M1. M1 steps run locally. M4 steps run over `ssh macbook-pro` with `BatchMode=yes` and `ConnectTimeout=5`, and the M4 must answer before anything changes.
- `--apply` holds the M1 heavy-job lock (`~/.m1-heavy.lock`) for the whole run: it reads `.next`, needs `df -g /` ≥ 44, and releases the lock on success and on failure.
- Each step does four things:
  - **Skips** when it is already in place, by its own check or by the marker `~/.config/tokenlayer/after-merge/<sha>/<step>` that a passing step writes.
  - **Checks itself** after it runs. A rerun only needs the job running, not restarted again.
  - **Stops the run** at the first failure. Nothing after it runs. It then prints a paste-ready rollback for every step this run changed, newest first.
  - **Never prints a secret value.** Env files are read only inside subshells.
- Fix the cause of a failure and rerun. The steps that finished are skipped.

## Order

| # | Mac | Step | Why here (receipt) | Check |
|---|---|---|---|---|
| 1 | M1 | commit | full SHA on origin/main (R10 §4 A) | ancestor of origin/main |
| 2 | M4 | reachable | every M4 step needs it (R2 probe options) | ssh exits 0 |
| 3–4 | both | root checkout → sha | `setup.sh pin` must exist in the checkout (Sol §5, R10 §4 A) | HEAD = sha, on main, clean |
| 5–6 | both | `setup.sh pin` | nothing reads `app/current` until a job is repointed (R10) | current → sha, marker |
| 7 | M1 | `setup.sh config` | the reader profile must be live before R5's views (R4, R5, R6) | live = render; 8 GiB cap; window order; writer uncapped; no restart |
| 8 | M4 | writer env | before the M4 ship restarts on the writer login (R6) | mode 600, user name |
| 9 | M1 | schema 008a, 006, 009, 012, as the writer (the reader runs no DDL) | the table before ship code (H1); one file each (Sol §5) | tables exist; view markers; views bind |
| 10–11 | both | ship | before the ratchet snapshot (H1); the M4 after #192/#195 (R10) | off the checkout; new PID; ok heartbeat in 120 s |
| 12–15 | M1 | drain, fable, dashboard, hubupdate | R10 §4 B; F3/F4; D1 | new PID; fable OFF; `/api/burn` rows |
| 16–17 | both | jev bundle | J2 | built = installed; a run exits 0 |
| 18–19 | M4 | usage bundle, plist → template | U2–U4; R9 (Homebrew bun); R11 §4.3 | fresh `usage.json`; no vite-plus lines |
| 20 | M1 | ratchet-live snapshot | last, once both ships beat (H1/H2) | tree = pin; the run at load exits 0; both heartbeat rows ≤ 900 s |
| 21–23 | both | drift-ignore spendtable, `setup.sh drift` | R11 §4 | exit 0 (M1: ClickHouse only, until its window) |

## Not in this script

- **The ClickHouse job:** it restarts the server, so it runs only in an approved window, with `--clickhouse-window`.
- **R12's repartition:** it has its own window (R12 §5). R8's `OPTIMIZE` is replaced by it.
- **Deleting data** (Etan decides each one):
  - `credentials_snap`;
  - R7's scratch tables;
  - the old ratchet-live copies and bundle backups.
