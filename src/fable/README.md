# Fable policy v2

The switch defaults to OFF. The Fable sidecar is the single writer of
`excluded_models` and `priority` on the two adopted credentials. Stop any older
sidecar before enabling this version. Catalog equality proves registered models,
not the absence of rules affecting future models; same-identity external rule
changes cannot be detected through this API.

`tokenlayer fable set --account <email>` requests ON. Non-Fable prefers B100 and
spills to A50. Strict is optional (`--strict` / `--no-strict`) and excludes only
concrete models B can currently serve. Active session affinity slides on every
hit; priority alone does not migrate existing sessions.

The Fable reserve is on by default: inferred non-Fable usage is
`7d - 0.5 * 7d_oi`, confidence medium. Missing Fable readings use `7d` conservatively.
At 0.45 the reserve excludes non-Fable from A even if B cannot serve it. That
conflict is DEGRADED. `set --allow-non-fable-on-fable-account` persists an override;
`set --protect-fable-reserve` restores protection. These commands use the saved
account when `--account` is omitted.

`tokenlayer fable off` restores both fields to null on both credentials without
the dashboard or daemon. It durably saves requested OFF before contacting the
hub. If unreachable, it exits 3 with the saved-request message; the daemon applies
OFF on its next reachable tick and never reasserts ON over requested OFF. OFF
nulls both rules on both baseline identities, then checks current catalogs against
the current registry and each other, plus priority field absence. Added or retired
models never require baseline adoption for OFF. Identity checks still apply.
Absent and null have equivalent runtime meaning on the attested installed hub
version. `status --json` uses indexed account arrays for desired maps (including
pending plans), omits the private baseline inventory, and exposes requested intent,
independently observed applied status, a reason, and any pending operation.
APPLYING/UNKNOWN never imply confirmed ON. Interrupted operations replan from
actual API observations. The daemon replans every 30 seconds; upstream failures
between ticks can interrupt availability.

WAIT_AT_CAP applies only to a real Fable cap (7d_oi rejected or at fableCapAt)
with spillover off (or auto without confirmed zero). A model cooldown alone is
transient: B serves Fable regardless of spillover, applied is DEGRADED, and the reason identifies the failure. Stale
but present signals on A also allow B to serve Fable. NO_UPSTREAM leaves both
catalogs unrestricted for that model. RESERVE_CONFLICT is the explicit D2 override
of the last-route rule for non-Fable. Missing weekly data or stale B observations
restore baseline policy and result in UNKNOWN.

Baseline import is limited to the digests of the exact lead-attested Nov 10
inventory (name/id, auth_index, email). It runs under the shared kernel lock and
records full model catalogs and provenance. Legacy pending operations are
replanned, not blindly replayed. Replacement inventory refuses ON policy writes and OFF refuses changed identity bindings.
`tokenlayer fable baseline adopt --credential <exact-name>` explicitly clears
both fields on that credential, reads its full catalog, and binds a new baseline.
Adopt each unrecognized identity before policy writes. This command is an explicit
adoption of normal routing, not a capture of unknown exclusion rules.

The executor expands all obsolete exclusions, sets priorities, and then refreshes
both catalogs and inventory before each restriction. Exact concrete catalogs and
priority readbacks must match. An empty 200 catalog is an error. Ambiguous PATCH
responses require the same readbacks as acknowledged responses. Every restriction
checks remaining usable routes and records permitted policy exceptions.

The executor's optional proof hook fixes writes to one non-Fable credential and
always reports UNKNOWN. It is for bounded operational receipts, not a CLI mode.

An unconfirmed reset press makes the count UNKNOWN: auto waits until the count is confirmed.

`fable run` reconciles external Claude usage-page resets even while policy is OFF.
For adopted Claude OAuth credentials (active or explicitly quota-errored) with only long quota cooldowns
(at least one hour remaining), it checks usage metadata through the hub API-call
endpoint at most once per three minutes per credential. The check time is saved
before I/O, including failures, so restarts retain the cadence. It never reads
OAuth secrets or logs upstream bodies/headers.

When the provider returns a usable `limits[]` list, recovery uses the snapshot
that latched each cooldown: `model_quotas[model_key]` for model scope, `quota` for
credential scope. A rejected header status or utilization of at least 99% marks
an exhausted meter. Its `7d` headers map to `weekly_all`, and `7d_oi` to every
`weekly_scoped` entry, regardless of display name. Every exhausted meter must now
report at most 50% usage, and no entry may report 95% or more. A snapshot without
an exhausted meter cannot prove recovery, even when all provider meters are low.
Every list entry needs a string kind, a finite numeric percent in [0, 100], and
a valid ISO reset time in the future; one malformed or stale entry makes the
whole list unusable and the check UNKNOWN, with no reset attempt.
An empty list or a list without a needed meter refuses recovery.
A cooled model with no saved quota snapshot blocks recovery for the credential.
Only the `7d` and `7d_oi` headers select exhausted meters; representative-claim
and five-hour headers do not select them.

Only an absent or null list retains the shared-weekly fallback: a same-window
drop of at least 50 percentage points from a prior observation of 90% or more,
or a naturally advanced reset window, with at most 50% currently used.
A present exhausted or invalid five-hour window prevents recovery on both paths;
null/missing windows remain UNKNOWN. Disabled credentials, auth failures,
short throttles, unchanged usage and ambiguous evidence do not release caches.
Identity and quota/cooldown observations are rechecked after metadata awaits.

Only the exact credential's local routing cooldown is reset. Durable attempt
snapshot hashes allow only one direct-meter attempt per latching snapshot, across
restarts and ambiguous attempts. A new rejection snapshot can qualify again in
the same weekly window; the fallback still suppresses repeats by allowance.
Direct recovery permits at most three attempts per credential per validated
weekly reset window, persisting the count before each POST across restarts.
Readback records `cleared` or
`unconfirmed`; neither proves a successful inference. Superseded passive quota
snapshots become UNKNOWN for policy decisions until new upstream observations
arrive, restoring normal routing instead of reapplying a stale rejection.
Reset inventory is never decremented or confirmed by reconciliation.
An unconfirmed clear retains cap policy while its quota cooldown remains active.
On the fallback path, natural weekly advancement permits one attempt without
proving that a separate Fable meter recovered; an early window move requires
the manual fallback. Direct-meter evidence does not depend on the window moving.

`tokenlayer fable reconcile` performs one pass with the same cadence and safety
checks. `status` and dry-run `plan` never trigger reconciliation. If conservative
evidence rules prevent automatic recovery after a known human reset, use
`tokenlayer fable reset-pressed --account <email> --op-id <unique-id>` to report
that press and attempt local recovery; reuse its operation id on retry. This
manual command updates reset bookkeeping, unless `--skip-count` is supplied for
recovery of an already-accounted press. No command presses Anthropic's reset.
