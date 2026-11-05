# Native history import

Run on the source machine, at its original current daemon paths, against the hub:

```sh
bun scripts/history/run.ts --manifest /outside/repo/pinned-native.json --epoch-bytes 1073741824
```

The default run verifies the first source's pinned first 32 records, accepts its `FINAL` coverage, then continues the entire supplied queue in autonomous epochs. `--pilot-only` exits after acceptance. No mtime filter or global 32-record limit applies. This command never runs from `--backfill`; that runner retains its 35 GiB floor.

The JSON manifest has `machine` (equal to `TOKENLAYER_MACHINE`) and ordered `sources`. Each source has `path` (absolute physical original path), `kind`, `sessionId`, `physicalSha256`, `decodedSha256`, `decodedBytes`, `prefixBytes`, `prefixSha256`. The first source's prefix must contain exactly 32 complete nonempty LF records. Plain/zstd twins have one logical identity: select the plain representation when both exist. Native Codex header UUID and filename must agree. Claude session IDs and Antigravity directory IDs are checked. Pins must come from source-side reads; metadata or a copied filename alone does not prove origin.

Use the current-root, never-shipped queue selected by the source inventory, with no date cutoff. Supported CLI roots match daemon Claude, Codex, Antigravity CLI and T3 Antigravity env settings. A manifest has at most 4,096 sources and 16 MiB of metadata; a source at most 64 GiB decoded and a record at most 1 MiB. Kiro, Gemini JSON, SQLite exports, moved roots, tar and Drive need their separate adapter/ownership slices. They are not queue completion claims here.

State is private under `~/.config/tokenlayer/history-import/<manifest-sha256>/`: independent progress/generation files, an fsynced intent/acked/ambiguous NDJSON ledger, and epoch receipts including before/after `FINAL` matrices. No payload is spooled. Live ship/backfill lineage is read only. Conflicting lineage or same-native ownership/hash overlap at another replacement identity stops admission for reconciliation. Exact existing keys are reused; repeated lines at different offsets remain events. Arbitrary cross-copy occurrence mapping is deferred.

Each epoch defaults to 1 GiB (512 MiB–1 GiB accepted). It reserves 384 MiB for scratch/state/overhead and charges exact JSONEachRow payload bytes plus 4× storage/merge allowance, cumulatively. Each insert re-queries free/unreserved space, retaining the installed 15 GiB reserve and another 2 GiB margin. Unknown/stale data, source mutation, unresolved ownership, insert errors, state caps and signals stop admission. One dispatched batch may finish. The 4× allowance is a conservative bound for this slice, not a universal measured amplification guarantee; independent writers still consume space.

Unacknowledged intent is re-queried by exact native keys on the next run: full coverage becomes acked, zero becomes retryable, partial/torn ledger stops for reconciliation. No automatic HTTP retry occurs. A writer lock prevents concurrent importer runs; SIGKILL leaves the lock as a technical stop. Inspect its PID/start/manifest and verify the previous writer is absent before an owner removes that exact lock; the importer never reaps it. Resume with the same manifest and retained state. Never remove live checkpoints or source/archive files.

Epoch matrices use provider harness and raw event month, including `197001`; that bucket can contain missing, invalid or explicit epoch dates. Dates and proxy fields are never manufactured. This slice does no schema migration, service restart, source deletion, archive download or `proxy_usage` write.
