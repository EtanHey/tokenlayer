# Claude admission

Scheduled lead wake: `bun run src/admit/main.ts --kind lead --active-leads 2 --essential`.

Allowed kinds: `lead`, `claude.judgment`, `claude.subagent.cheap`, and
`claude.subagent.mechanical`. Exit 0 admits; exit 1 denies. Every outcome prints
one JSON line with `admit`, `reason`, `level`, `pacing`, and account assessments.
Input defaults to `~/.config/tokenlayer/usage.json`; `--file PATH` and `--now ISO`
support replay. Errors never echo input contents, paths, or account labels.

Uses usage-refresher PR #9's snapshot shape: `generated_at`, `stale`,
`accounts[].disabled`, `status`, `five_hour.{used_pct,resets_at}`, `weekly.used_pct`.
Serving means not disabled and not explicitly `enabled:false`; `active` does not
exclude an account. Optional per-window status must be `allowed`. Any unknown or
rejected serving account, exhausted weekly window, missing/malformed input, stale
snapshot, future timestamp, or age over 180 seconds denies everything. No serving
accounts denies. Resets in the past or at least 300 minutes away also deny because
pacing requires positive elapsed time.

The worst account decides. Below 60%, workers can start; leads need fewer than 10
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
for the model. TLC 2.19 checked all 1,056 abstract states without errors. It models
admission decisions with stuttering transitions, not atomic dispatch or telemetry
collection. The implementation enumeration expands all three worker kinds and
uses realizable pacing inputs (zero usage cannot pace). The jar stays outside
the repo.
