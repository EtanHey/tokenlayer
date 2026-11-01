# Archaeology

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
