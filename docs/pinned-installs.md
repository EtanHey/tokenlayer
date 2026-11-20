# Pinned installs

tokenlayer's launchd jobs run from `~/.config/tokenlayer/app/current`, not from a git checkout.
`current` is a symlink to `app/<sha>`, which holds the tree at one commit. A checkout, pull or branch switch in
`~/Gits/tokenlayer` never changes a running job.

## Install a commit

From any checkout that has the commit (fetch first; the checkout's branch is never changed):

```sh
scripts/deploy/setup.sh pin <sha> [--restart com.tokenlayer.ship ...]
```

The commit must be on `origin/main` (`git merge-base --is-ancestor`), so fetch first. An unmerged branch or PR head is
refused before anything is written: a pinned job runs with the hub management key and the writer login. For a
rehearsal only, `setup.sh pin <sha> --allow-unmerged` installs it anyway and prints a warning.

The install takes four steps:

1. `git archive <sha>` into `app/.staging-<sha>-<pid>`.
2. `bun install --production --frozen-lockfile` in that copy.
3. Write the `.tokenlayer-commit` marker and rename the copy to `app/<sha>`.
4. Flip `current` atomically, then `launchctl kickstart -k` each label given after `--restart`.

If any step fails, the staging copy is removed and `current` is left as it was. Installing a commit that is
already installed only flips the symlink.

## Roll back

```sh
scripts/deploy/setup.sh use <full-sha> [--restart com.tokenlayer.ship ...]
```

`use` refuses any commit without a complete `app/<sha>`. Old releases stay until someone deletes them.

## Move a job off the checkout (once per job)

A kickstart does not re-read a plist, so the first move needs a reload. Repoint the live plist: it changes only
the checkout paths, so the switch carries no other change. Since R11 the templates render every live plist, so
`setup.sh drift` is clean right after the repoint (see below).

```sh
cp ~/Library/LaunchAgents/com.tokenlayer.<job>.plist ~/.config/tokenlayer/backups/
bun ~/.config/tokenlayer/app/current/scripts/deploy/pin.ts repoint ~/Library/LaunchAgents/com.tokenlayer.<job>.plist
plutil -lint ~/Library/LaunchAgents/com.tokenlayer.<job>.plist
launchctl bootout gui/$(id -u)/com.tokenlayer.<job>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenlayer.<job>.plist
```

`repoint` rewrites every plist string that is `~/Gits/tokenlayer` or a path inside it. It refuses a plist that has
none. `setup.sh hub` and `setup.sh ship` render new plists against `app/current` and refuse to run before a `pin`.

## Every job from the repo, and drift

`scripts/deploy/jobs.ts` lists every job, the Macs it runs on and the values its template needs. One renderer
serves all of these:

| Command | Jobs |
|---|---|
| `setup.sh hub` | clickhouse (M1; also writes its config and applies the schema) |
| `setup.sh ship m1` / `ship m4 <url>` | drain (M1) and ship (both) |
| `setup.sh <job>` | dashboard, fable, hubupdate, ratchet-live (M1); jev (both); usage (M4) |

Each renders the template, runs `plutil -lint`, then boots the job out and in. Values that stay out of this public
repo (the dashboard's `TOKENLAYER_DASHBOARD_LOGINS` and `TOKENLAYER_DASHBOARD_ORIGIN`, ratchet-live's `TOKENLAYER_RATCHET_OUTBOX`) come from the
environment, else from the installed plist; with neither, the install refuses. `setup.sh ratchet-live` only
rewrites the plist: refresh its snapshot first (docs/ratchet.md).

```sh
scripts/deploy/setup.sh drift [m1|m4]   # read-only; the Mac defaults to TOKENLAYER_MACHINE in ship.env
```

`drift` parses each `~/Library/LaunchAgents/com.tokenlayer.*.plist` with `plutil` and compares it with what this
tree renders: key order, whitespace and comments are ignored, and every value must match. It prints `ok`, or
`DRIFT` with each differing path, and exits 1 on any drift. It also fails for a missing job and for a
`com.tokenlayer.*` label with no template. Each path reads `differs`, `only-live` or `only-template`, and its
output is safe to log: nothing under `EnvironmentVariables` is ever printed, only key names; elsewhere a value is
shown only when it is a number, a boolean, a path or a bare `--flag` (so `--password=…` and other words in
`ProgramArguments` read as `differs` with no value); a dict or array on one side only is listed key by key. A label that is deliberately not from this repo goes in `~/.config/tokenlayer/drift-ignore`, one per line.
