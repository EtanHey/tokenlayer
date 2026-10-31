Add a schema-1 row to `ratchet/rows.json`. Commands exit nonzero on failure; numeric measurements print a finite last line. `real` rows include bug/fix SHAs. CI publishes the main-versus-PR table, including report-only M1 rows.

PR CI archives the exact base SHA's `ratchet/` and benchmark into a separate temporary directory. Its table, policy guard, and measurement scripts judge the candidate source. Editing the PR's judge/measurement files cannot disable that gate. Row removal, looser ceilings/regression bands, command/metric/runner/direction/kind changes, and changed provenance require **both** the `ratchet-change` label and the exact `ratchet-change: <id> <field>=<JSON value> ...` line printed by the guard in the PR body (`ratchet-change: <id> removed` for removal). Label/body edits rerun CI. Ordinary improvements need no exception.

First-adoption boundary: base `e1cd4224f3d6adc84f46c899cf043f5702104667` predates this guard. Only that SHA runs its own trusted legacy measurements and then the new candidate judge; that reviewed bootstrap cannot prove the new guard's trust until merged. Every later base must supply the guard; there is no generic fallback. Workflow changes still require review; the lead must separately require this check in branch protection.

Bun and ClickHouse on PATH are required. Unit-test count must be at least main's passing count, so removed/skipped tests reduce it. Integration tests must execute without skips.

Throughput uses a trusted median-of-five benchmark on both source trees: >=15 MB/s and >=75% of main. A green main push measures the trusted main tree, then a separate main-only write job commits `max(existing floor, floor(0.8 * median * 100) / 100)`. It never lowers the floor, refuses nonfinite medians, and rejects a push if main advanced meanwhile. The token is read-only on PR runs. The bot's floor-only commit does not trigger another Actions run. The M1 floor remains 20 MB/s, report-only until R1.

Local: `RATCHET_BASE_REF=origin/main node /path/to/trusted/ratchet/table.mjs ratchet/rows.json`. Approved migrations also need a saved PR event in `GITHUB_EVENT_PATH`; omit it to verify fail-closed behavior. Main push runs compare main against itself, since PR policy was checked before merge.

R1 numeric max rows may specify `allowance` (absolute units), `growth` (fraction of main), or both; the budget is main plus the smaller allowance. Missing main measurements fail. All changes to these fields on existing rows require the existing `ratchet-change` label and exact per-row disclosure; they cannot silently relax a ceiling.

The trusted base archives its R1 harness and fixtures, then imports each source tree's serializers, shipper and schema. Policy is checked against the PR base; measurements use `origin/main` in the same job, including stacks. One run-scoped receipt per tree shares the expensive replay across rows and never reuses a previous invocation.

The replay generates 50,000 deterministic lines and verifies every row through FINAL. The judge samples `ship-ingest-rows-s` using five alternating base/PR pairs through the same trusted harness, comparing the two medians and printing all ten samples. Each sample includes production parsing, batching and confirmed inserts at unlimited replay rate. `--ingest-sample` never reuses a receipt. Keep ingest throughput report-only until three CI runs justify a band of at least 25%; local measurements do not establish shared-runner variance. Append-to-FINAL lag is one observed replay per tree.

Numeric CI rows may set `reportOnly: true`: they still run, display main/PR values, budget and delta, and show REPORT ONLY without gating on the threshold. Missing/failed measurements still fail. Changing this flag on an existing row requires the same exact disclosure and label as other policy changes. Use report-only CI wall times alongside `runner: m1` twins until deployment activates hardware measurements; CI still reports M1 rows as pending deploy.

Queries have two warmups plus 20 timed requests (nearest-rank p95). After OPTIMIZE and stopping background merges, the harness also runs each golden query with the query cache disabled, one thread and fixed block size. It flushes logs and identifies exactly one QueryFinish by a unique log comment, yielding `<query>-read_rows`, `-read_bytes`, `-result_rows`, `-result_bytes` and `-memory_usage`. Query row policy should use `growth: 0.02` (memory: `0.05`); memory allocation can vary slightly. The harness emits `session-active-parts`, `ship-insert-batches`, and `ship-insert-batch-<n>-rows` for deterministic ingest budgets. Storage remains active bytes_on_disk after OPTIMIZE scaled to 10k rows. CI has a six-minute hard timeout.

M1 rows are report-only until deployment; `bun ratchet/live.ts <row-id>` reads local credentials without printing them. Cache ratio is read tokens divided by total creation tokens (W5m + W1h); w1h share uses the raw one-hour creation breakdown. Unknown/zero-denominator telemetry fails the probe. Live ship lag is event timestamp to ingest timestamp p95 over the last day and can include historical replays. No M1 values are claimed by CI.

Normal tests retain 40-trial shipper property smoke checks (`TOKENLAYER_PROPERTY_N` defaults to 40).
Long `*.property.test.ts` entries are excluded from default discovery. `bun run test:property` explicitly
runs them with `TOKENLAYER_PROPERTY_N=300`; the required `ci` job gives that step its own 10-minute budget.
The full step retains all archive assertions and checks 300 completed operation sequences / 1,200 SIGKILLs.
Ratchet commands and limits stay unchanged; their default measurements include the short smoke checks.
