# Claude admission

Scheduled lead wake: `bun run /Users/happycampr/Gits/tokenlayer/src/admit/main.ts --kind lead --active-leads 0 --essential`.

Allowed kinds: `lead`, `claude.judgment`, `claude.subagent.cheap`, and
`claude.subagent.mechanical`. Exit 0 admits; exit 1 denies. Every outcome prints
one JSON line with `admit`, `reason`, `level`, `pacing`, and account assessments.
Input defaults to `~/.config/tokenlayer/usage.json`; `--file PATH` and `--now ISO`
support replay; `--now` requires an explicit `--file` to protect the default live clock. Errors never echo input contents or paths. Successful assessments include each account label.

Uses usage-refresher PR #9's snapshot shape: `generated_at`, `stale`,
`accounts[].disabled`, `status`, `five_hour.{used_pct,resets_at}`, `weekly.used_pct`.
Candidates are not disabled and not explicitly `enabled:false`; `active` does not
exclude an account. Rejected or unknown accounts (including either window status),
and exhausted weekly or five-hour windows have no headroom and are excluded.
A partial or fully null window is unknown for that account only; healthy siblings still decide.
A producer-marked `{used_pct:0,resets_at:null,rolled_over:true}` window has 0% usage
and no pacing warning. It restores headroom after an idle reset without inventing a reset time.
A weekly rejection overrides five-hour headroom. Admission uses only accounts
with headroom; no such accounts denies. Missing/malformed input, stale snapshots
(`stale:true` or age over 180 seconds), and future timestamps deny everything.
Resets in the past or at least 300 minutes away also deny because pacing requires
positive elapsed time. Output `accounts[]` contains the assessed accounts with
headroom, each with `label`, `level`, and `pacing`.

The worst account with headroom decides. Below 60%, workers can start; leads need fewer than 5
active leads. At 60%, workers stop and leads need fewer than 2 active leads. At
80%, workers stop; leads need `--essential` and fewer than 1 active lead. Leads
must supply `--active-leads`. Pacing is used percentage times 300 divided by
elapsed minutes. A score strictly over 80 warns and applies brake60 to workers.
Lead rules remain based on utilization. Aggregate pacing describes the most
restrictive account (highest score breaks ties). Invalid telemetry has null
pacing numbers and empty accounts.

The caller must count active leads, serialize concurrent admissions, enforce
worker caps (judgment 2, cheap 2, mechanical 4), the shared 7-slot judgment ceiling
(including leads), and workers’ <=20% share of rolling five-hour usage. Canon also
limits spending to <=6 weekly percentage points per five-hour window until weekly
reset. The caller must track that delta: this snapshot has no window-start baseline.
These caller limits and the enforced lead caps live in `src/admit/policy.ts`.
This command does not reserve slots or measure weekly spending.

`tests/fixtures/admit/fleet-canon-5.md` vendors canon #5 for deterministic offline
tests. CI diffs this section against the golems default branch (currently `master`, not `main`) and fails on drift, including
wording changes; review the new canon, update policy/model/docs and refresh the
fixture together. Other canon sections cannot spuriously break admission CI.

Run `bun test tests/admit` for CLI fixtures and finite implementation enumeration.
With a JDK installed, run:
`java -cp ~/.cache/tla/tla2tools.jar tlc2.TLC -workers 1 -metadir docs.local/admit-states -config spec/Admit.cfg spec/Admit.tla`.
TLC checked 76,432 distinct states (330,296 generated), depth 15, with no error.
The model has two accounts and two concurrent dispatchers, queued requests,
atomic admission/reservation and finishes, including 5/2/1 caps and essential turns.
Unknown/rejected/exhausted accounts provide no headroom; rollover means zero usage.
Telemetry is fixed per exploration, so the invariants describe admissions under a
snapshot, not forced termination after telemetry changes. Workers use a presence
abstraction; per-role caps, budget accounting and collection remain caller obligations.
The CLI only checks: callers must serialize the check plus their own reservation as
modeled. The implementation enumeration expands all three worker kinds.
The jar and TLC state files stay outside tracked source.
