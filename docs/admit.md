# Claude admission

Scheduled lead wake: `bun run /Users/happycampr/Gits/tokenlayer/src/admit/main.ts --kind lead --active-leads 0 --essential`.

Allowed kinds: `lead`, `claude.judgment`, `claude.subagent.cheap`, and
`claude.subagent.mechanical`. Exit 0 admits; exit 1 denies. Every outcome prints
one JSON line with `admit`, `reason`, `level`, `pacing`, and account assessments.
Input defaults to `~/.config/tokenlayer/usage.json`; `--file PATH` and `--now ISO`
support replay; `--now` requires an explicit `--file` to protect the default live clock. Errors never echo input contents or paths. Successful assessments include each account label.

Uses the usage-refresher snapshot: `generated_at`, `stale`, and per-account
`disabled`, `status`, `five_hour` and `weekly` readings. Candidates are not disabled
and not explicitly `enabled:false`; `active` does not exclude a serving account.
Each reading has `used_pct` and `resets_at`. When unified rate-limit headers exist
but none name a window, the producer marks that window
`{used_pct:null,resets_at:null,absent:true}`. An absent window has no brake.
No unified signals, a null percentage in a present window, or both windows absent
means unknown. Unknown or rejected accounts (including either window status),
and accounts at 100% in any present window have no headroom. They are excluded;
a healthy sibling can still admit. No accounts with headroom denies.

Check each present window separately: five-hour windows last 300 minutes and
weekly windows last 10080 minutes. At 95% used, the window is `stop`. Otherwise,
after at least 10% of the window has elapsed, it is `slow` when used percentage
times window minutes divided by elapsed minutes is greater than 100. Otherwise
it is `green`. Elapsed time is window length minus minutes until reset. A missing
reset applies only the 95% stop; it cannot trigger projection. A producer-marked
`{used_pct:0,resets_at:null,rolled_over:true}` window is green with zero usage.
Resets in the past or at least the window length away are bad telemetry.
Missing/malformed input, stale snapshots (`stale:true` or age over 180 seconds),
and future snapshot timestamps deny everything.

An account takes its tightest present window. The fleet takes its best serving
account with headroom because the hub can fail over. At `green`, workers can
start and leads need fewer than 5 active leads. At `slow`, workers cannot start
and leads need fewer than 2 active leads. At `stop`, workers cannot start; leads
need `--essential` and fewer than 1 active lead. Leads must supply `--active-leads`.
The same window rules apply to leads and workers.

Output `accounts[]` contains accounts with headroom, each with a safe `label`,
`level`, and `pacing`. Pacing maps each present window to
`{used,elapsed_min,projected}`. A missing reset gives null elapsed and projection;
rollover gives null elapsed and zero projection. Absent windows are omitted.
Top-level pacing describes the best account; denied or invalid telemetry has
empty pacing and accounts when no assessment is available.

The caller must count active leads, serialize concurrent admissions, enforce
worker caps (judgment 2, cheap 2, mechanical 4), the shared 7-slot judgment ceiling
(including leads), and workers’ <=20% share of rolling five-hour usage.
These caller limits and the enforced lead caps live in `src/admit/policy.ts`.
Weekly projection replaces the weekly-points budget. This command does not reserve
slots or measure spending deltas.

`tests/fixtures/admit/fleet-canon-5.md` vendors canon #5 for deterministic offline
tests. The non-required `canon-drift` CI job diffs this section against the golems default
branch (currently `master`, not `main`) and fails on drift, including wording changes; review the new canon, update policy/model/docs and refresh the
fixture together. Other canon sections cannot spuriously break admission CI.

Run `bun test tests/admit` for CLI fixtures and finite implementation enumeration.
With a JDK installed, run:
`java -Djava.io.tmpdir="$PWD/.local" -cp ~/.cache/tla/tla2tools.jar tlc2.TLC -workers 1 -metadir .local/admit-states -config spec/Admit.cfg spec/Admit.tla`.
TLC checked 101,760 distinct states (458,240 generated), depth 15, with no error.
The model has two accounts and two concurrent dispatchers, queued requests,
atomic admission/reservation and finishes, including 5/2/1 caps and essential turns.
Each model reading abstracts an account’s tightest present window. Projection is
abstracted as a boolean; the best eligible account decides. Unknown/rejected/exhausted
accounts provide no headroom; rollover means zero usage.
Telemetry is fixed per exploration, so the invariants describe admissions under a
snapshot, not forced termination after telemetry changes. Workers use a presence
abstraction; per-role caps, budget accounting and collection remain caller obligations.
The CLI only checks: callers must serialize the check plus their own reservation as
modeled. The implementation enumeration expands all three worker kinds.
The jar and TLC state files stay outside tracked source.

Run `python3 scripts/check-admit-blind-mutation.py` to reproduce the independent
raw-field safety check: the unknown-as-headroom mutation passes the old oracle
and violates `NoBlindAdmit`. Logs stay in `docs.local/admit-blind-mutation/`.
