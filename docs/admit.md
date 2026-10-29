# Claude admission

Scheduled lead wake: `bun run src/admit/main.ts --kind lead --active-leads 2 --essential`.

Allowed kinds: `lead`, `claude.judgment`, `claude.subagent.cheap`, and
`claude.subagent.mechanical`. Exit 0 admits; exit 1 denies. Every outcome prints
one JSON line with `admit`, `reason`, `level`, `pacing`, and account assessments.
Input defaults to `~/.config/tokenlayer/usage.json`; `--file PATH` and `--now ISO`
support replay. Errors never echo input contents or paths. Successful assessments include each account label.

Uses usage-refresher PR #9's snapshot shape: `generated_at`, `stale`,
`accounts[].disabled`, `status`, `five_hour.{used_pct,resets_at}`, `weekly.used_pct`.
Candidates are not disabled and not explicitly `enabled:false`; `active` does not
exclude an account. Rejected or unknown accounts (including either window status),
and exhausted weekly or five-hour windows have no headroom and are excluded.
A weekly rejection overrides five-hour headroom. Admission uses only accounts
with headroom; no such accounts denies. Missing/malformed input, stale snapshots
(`stale:true` or age over 180 seconds), and future timestamps deny everything.
Resets in the past or at least 300 minutes away also deny because pacing requires
positive elapsed time. Output `accounts[]` contains the assessed accounts with
headroom, each with `label`, `level`, and `pacing`.

The worst account with headroom decides. Below 60%, workers can start; leads need fewer than 10
active leads. At 60%, workers stop and leads need fewer than 5 active leads. At
80%, workers stop; leads need `--essential` and fewer than 3 active leads. Leads
must supply `--active-leads`. Pacing is used percentage times 300 divided by
elapsed minutes. A score strictly over 80 warns and applies brake60 to workers.
Lead rules remain based on utilization. Aggregate pacing describes the most
restrictive account (highest score breaks ties). Invalid telemetry has null
pacing numbers and empty accounts.

The caller must count active leads, serialize concurrent admissions, enforce
worker caps (judgment 2, cheap 2, mechanical 4), the shared judgment ceiling, and
worker budget share. This command does not reserve slots.

Run `bun test tests/admit` for CLI fixtures and finite implementation enumeration.
Run `java -cp ~/.cache/tla/tla2tools.jar tlc2.TLC -config spec/Admit.cfg spec/Admit.tla`
for the model. TLC build 2026.10.28.014557 checked all 4,224 abstract states without errors. It models
admission decisions with zero, one, or two accounts with headroom and
stuttering transitions, not atomic dispatch or telemetry collection. The implementation enumeration expands all three worker kinds and
uses realizable pacing inputs (zero usage cannot pace). The jar stays outside
the repo.
