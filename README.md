# tokenlayer

Sidecars around a self-hosted [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub, following
[Theo's hub guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af):

- **steer** — soonest-reset-first routing without forking the proxy: reads each credential's captured
  rate-limit reset times from the management API and moves the account that resets soonest to the top priority tier.
- **drain** — persists the proxy's per-request usage records (tokens, cache reads/writes, account, latency) to ClickHouse.
- **ship** — ships Claude Code, Codex and T3 Code session JSONL from every machine into the same ClickHouse.

No secrets live in this repo. See `config/cliproxyapi.conf.template`.

Archaeology currently supports dry-run and throwaway validation only; no apply mode exists.
Its CLI requires `--existing EXPORT.tsv`, even for a dry-run. The export must describe what
ClickHouse actually holds after `FINAL`, with columns `machine`, `session_id`, `path` (or `stream`),
`generation`, `content_hash`, and `count`. Use the native stream owner for `session_id`, including
rows without an inline id; retain subagent stream identity. A header-only export means the server
is empty. Missing exports and malformed headers fail closed.

Each `count` is per **(machine, stream, path, generation, content_hash)**. Never sum occurrences
across paths or generations: coverage uses the maximum per stream/hash within one machine.
Local live files are candidates, not evidence of server coverage: an uncheckpointed file older
than 24 hours may have been skipped without shipper `--backfill`. Uncovered live lines are included
in the import projection and deduplicated against archive copies. The library's optional export
supports conservative fixture projections with zero assumed server coverage; any future apply
must require a fresh server export and recheck the disk gate (at least 35 GiB real free after import).
