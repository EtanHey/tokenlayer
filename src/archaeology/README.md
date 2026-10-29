# Read-only archaeology
Requires the immutable/exact-raw shipper schema (#16/#19), Bun, Python 3 and zstd for compressed rollouts.
Run `bun src/archaeology/main.ts --inventory /absolute/inventory.tsv --evidence /absolute/evidence.ndjson --out /absolute/new-output --validate`.
Repeat `--inventory` for additional inventories. `--manifest /absolute/manifest.tsv` replays an earlier manifest into a different output directory.
`--existing /absolute/pairs.tsv` seeds a read-only shipper export with columns `session_id`, `stream` (or source `path`), `content_hash`, and positive integer `count`. Coverage uses the maximum count per stream/hash; it never sums duplicate copies.

Evidence NDJSON contains `cwd`, `repo` (`owner/name`), `evidence`, and `confidence` (`high`/`medium`). GitHub redirects and current remotes must be gathered read-only before running. Conflicting identities remain unresolved.
`repo_map` intervals cover observed timestamps, with an exclusive upper bound; they do not prove a directory was never reused.

The library accepts replayable streams. The local adapter reads files twice and streams tar containers sequentially, holding one member in memory (1 GiB guard), without extraction. Remote and dataless sources need fetching; T3 SQLite metadata needs transcript export.
`manifest.selected` recommends the longest candidate; verified divergent copies also remain selected. Every accessible copy is compared and counted so prefix and duplicate skips are observable. Remote relationships remain unverified.

Only LF-terminated lines count. Trailing incomplete bytes are reported. Invalid UTF-8 and changed/unreadable sources fail closed and remain explicit in the manifest. Raw retains all source whitespace and LF; hashes cover those exact bytes.
The SQLite scratch index contains session/stream ids, hashes and occurrence maxima. A stream is a session plus its subagent file id (main transcripts use `::main`). Reports never contain raw lines. `--validate` inserts at most 100 sample rows into a random-port throwaway local ClickHouse and tears it down; no shared endpoint is accepted. There is no apply mode.

Focused verification: `bun test tests/archaeology`. Full verification: `bun run typecheck && bun test`.
