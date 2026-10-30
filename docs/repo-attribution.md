# Session repo attribution

`src/lib/repo.ts` shares lexical cwd rules between shipper `projectFromCwd`,
archaeology `repoHint`, and generated ClickHouse functions. No filesystem lookup is used. `~/Gits/<repo>/…` (including historical `Desktop/Gits`) and T3 worktrees
resolve to their enclosing repo on either Mac. Historical superpowers/rig hints remain supported. Unknown cwd strings, including external lab directories, are
`(other)`; existing archaeology Git evidence remains separate.
Only streams with **no recorded cwd on any line** use Claude project slugs.
The single `KNOWN_REPOS` list matches case-insensitively, longest complete name
first; unknown slugs are `(other)`. Encoding is lossy, so known-name collisions
remain possible. Recorded unknown cwd takes precedence. Context `cwd_basename`
retains the raw cwd basename or raw fallback slug for debugging.
Run `bun run schema:apply` with existing deployment configuration to update the
functions and context view. All existing rows are corrected at query time;
physical archive columns/raw bytes stay unchanged. No backfill is needed.
The daily view keeps `day, repo, model, harness, machine, sessions`. This PR does
not deploy to M1. Synthetic integrations check exact rows and archive preservation.
