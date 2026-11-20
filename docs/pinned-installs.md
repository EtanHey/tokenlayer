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

A kickstart does not re-read a plist, so the first move needs a reload. Repoint the live plist rather than
re-rendering it from a template: the live plists carry settings the templates lack.

```sh
cp ~/Library/LaunchAgents/com.tokenlayer.<job>.plist ~/.config/tokenlayer/backups/
bun ~/.config/tokenlayer/app/current/scripts/deploy/pin.ts repoint ~/Library/LaunchAgents/com.tokenlayer.<job>.plist
plutil -lint ~/Library/LaunchAgents/com.tokenlayer.<job>.plist
launchctl bootout gui/$(id -u)/com.tokenlayer.<job>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokenlayer.<job>.plist
```

`repoint` rewrites every plist string that is `~/Gits/tokenlayer` or a path inside it. It refuses a plist that has
none. `setup.sh hub` and `setup.sh ship` render new plists against `app/current` and refuse to run before a `pin`.
