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

M1 rows are report-only until deployment; `bun ratchet/live.ts <row-id>` reads local credentials without printing them. Cache ratio is read tokens divided by total creation tokens (W5m + W1h); w1h share uses the raw one-hour creation breakdown. Both read `FINAL` per partition, like `ch_live_query_p95_ms` below. Unknown/zero-denominator telemetry fails the probe. Live ship lag is, per machine, the p95 of first ingest minus event time over events written in the last hour, and the worst machine is reported; 1970-dated imports, history replays and generation replays do not count, and no live events reads 0 (a shipper that stops trips the row once its backlog lands). A shipper that stops and never restarts lands nothing, so `ship_heartbeat_age_s_m1` and `_m4` read the age of each Mac's newest `tokenlayer.ship_heartbeat` row by the server's clock (`ingested_at`); the ship daemon writes one row a minute, and at once when a pass's error class changes (`src/ship/heartbeat.ts`). Ceiling 900 s; no heartbeat at all is MISSING. The M4 row first asks the M4 over the same ssh probe as `usage_json_age_s`: asleep or off the tailnet prints `skip`, and so does a wake under 300 s ago with no heartbeat since, so a dead shipper on an awake M4 posts one FAIL and sleep never clears or re-posts it. A `--backfill` run never beats. `usage_json_age_s` reads the M4's `usage.json` over `ssh macbook-pro`; an asleep or offline M4, or one that woke under 180 s ago with no post-wake snapshot, prints `skip` and the scheduler holds the row's state. `ch_live_query_p95_ms` times a 1-day `FINAL` query with `do_not_merge_across_partitions_select_final=1`: without it `FINAL` cannot prune by `ts` and reads the whole table (see `ratchet/live-sql.ts`). `v_session_events_context` and the archaeology `existing.sql` export read `session_events FINAL` the same way. `jev_unreconciled_24h` counts Jev reservations with no reconciliation 15 min after reservation, over the last day (ceiling 0; see docs/jev.md). No M1 values are claimed by CI.

### Live rows on a schedule (M1)

`com.tokenlayer.ratchet-live` runs every `bun ratchet/live.ts <id>` row every 15 min (`ratchet/live-schedule.ts`).
A row that turns red appends one line to the orc outbox, `### tokenlayer-ratchet → @tokenlayer-lead @orc — <time> FAIL <row>: value <v>, threshold <limit>`,
and one `cleared` line when it turns green again; nothing while it stays the same or while a probe prints `skip`. State: `~/.config/tokenlayer/ratchet-live-state.json`.
`TOKENLAYER_RATCHET_OUTBOX` is required; `TOKENLAYER_RATCHET_OVERRIDE='{"row": value}'` forces values for a proof run (lines say `(override)`).

`claude_burn_2h` catches an idle Claude week (whatever is left at the weekly reset is lost) and a week burnt too fast.
It reads the hub's own `anthropic-ratelimit-unified-7d-utilization` and `-7d-reset` in `proxy_usage.ratelimit`
(fractions; `7d_oi`, the separate Fable quota, is not counted): per account, the last reading before the window, then
the max per 15-minute bucket, counted back from now so the last hour starts on a bucket edge. The week used is each
account's rises summed over accounts (a new weekly cycle that began in the window counts its use; one that began
earlier counts only the rise after its first reading). No request at all reads 0%/h.

The target is not a constant. Every run computes it from the in-use account (the latest reading):
`target %/h = (week % left − reserve %) / hours until that account's weekly reset`, 0 at or under the reserve.
A reset that has passed with no reading since is a new week: 100% left until the next weekly reset.
The reserve is orc's, `reserve_pct` in `~/.config/tokenlayer/burn-target.json` (`TOKENLAYER_BURN_TARGET` overrides
the path; other keys, like the old `pct_per_hour` and `until`, are not read):

```json
{"reserve_pct": 8, "set_by": "orc"}
```

No file or no `reserve_pct`: the default 8, and every line says the default is in use. A malformed file, or a
`reserve_pct` outside 0 to under 100, is a broken probe (FAIL, value MISSING). No Claude reading in 8 days gives no
target and fails. The row fails when the last 2 h ran under half the target, or the last hour over twice it.
No quiet hours. Its posts read in words, times in Israel time with IST/IDT:
`FAIL claude_burn_2h: under half the target: Claude ran 0%/h for the last 2 h and 0%/h for the last hour against a 1%/h
target (alarm under 0.5%/h for 2 h or over 2%/h for 1 h); target = (45% of the week left − 8% reserve) / 37 h until the
reset Sat 03:00 IST`. A probe judges against its own threshold by printing `{"value", "threshold", "say"}` as its last
line; `threshold: null` means report only. A probe that judges two sides adds `"fail"`, which decides the row.

Install from a merged tree (the job runs from a snapshot, so a worktree cleanup cannot break it). Set `OUTBOX` to the orc outbox file first; its path stays out of this public repo:

```sh
dest=~/.config/tokenlayer/ratchet-live; rm -rf "$dest.new"; mkdir -p "$dest.new"
git archive origin/main | tar -x -C "$dest.new" && rm -rf "$dest" && mv "$dest.new" "$dest"
TOKENLAYER_RATCHET_OUTBOX=$OUTBOX scripts/deploy/setup.sh ratchet-live   # later runs keep the installed outbox
```

Normal tests retain 40-trial shipper property smoke checks (`TOKENLAYER_PROPERTY_N` defaults to 40).
Long `*.property.test.ts` entries are excluded from default discovery. `bun run test:property` explicitly
runs them with `TOKENLAYER_PROPERTY_N=300`; the required `ci` job gives that step its own 10-minute budget.
The full step retains all archive assertions and checks 300 completed operation sequences / 1,200 SIGKILLs.
Ratchet commands and limits stay unchanged; their default measurements include the short smoke checks.
