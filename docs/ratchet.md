1. Add a row to `ratchet/rows.json` (fleet schema); use `runner: ci`, a timeout, and a threshold that passes today.
2. Make its command exit nonzero on failure; numeric rows print a finite number on their last stdout line; real rows include `bug_sha`/`fix_sha`.
3. Open a PR: CI installs tools, measures main and the PR, and publishes the table automatically; removed/loosened rows, missing measurements, regressions, and ceiling breaches fail.

R0 uses synthetic/unit CI measurements plus the known null-window fixture regression; live performance belongs in R1. The first adoption has no main rows and reports `bootstrap`; subsequent PRs measure main's own rows in a temporary tree. Pushes compare with the previous main SHA. Local runs use `origin/main` (override with `RATCHET_BASE_REF`); TLC requires `TLA_JAR` and ClickHouse must be on PATH. Run `node ratchet/table.mjs ratchet/rows.json`.

Throughput uses the median of five runs of the same harness against each source tree on the same CI runner. CI requires at least 5 MB/s and 75% of freshly measured main throughput (25% noise allowance); deterministic counts retain strict comparison. The 20 MB/s M1 row is defined and report-only until R1. PRs compare to origin/main, including stacked PRs.
