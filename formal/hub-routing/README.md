# Hub routing: round 2, MODEL_ONLY, Target NOT_GREEN

Round 1's oracle-based Target result is withdrawn. This revision composes a
controller with the hub. Controller actions never read `quota` or `reset`.
They read passive `obs`, `seenReset`, per-meter ages and management-visible
cooldown/disabled state, and write global credential priority and per-model
exclusions. The hub reads those persisted fields, bindings and model cooldowns.
Only upstream response, external-use/reset actions and outcome monitors read true
quota. No installed controller, API behavior or live traffic is certified.

Target still violates required properties. These counterexamples are design
findings for C1, not accepted expected-green cases. The runner exits **1** when
Target fails, retaining named traces. Do not weaken a property or turn its expected
outcome into a violation to get exit 0. The PR body retains the historical first
round; the round-2 PR comment contains the current receipts and corrections.

## Run and receipt contract

```
python3 formal/hub-routing/check.py --output "$PWD/.local/receipts-t1-r2"
```

M4's default cached jar differs from the inherited pin. Use
`--jar "$PWD/.local/tla2tools.jar"` with the matching jar copied from M1 during
round 1. No tool is downloaded, replaced or installed by the runner. The jar hash
is pinned. `toolchain.json` accepts either recorded M4 Java 26 or M1 Java 27
binary **and exact version**, records the selected pin and actual hostname, and
rejects unknown binaries. Unicode escapes in the Java 27 version encode literal
dots in JSON, avoiding the publication hook's address-shaped-version false
positive. They decode to the original exact version before comparison.

One worker, 512 MiB heap, default 64 MiB offheap, 90 seconds/config, 900 seconds/run;
fixed seed 1 and fingerprint polynomial 0. Each invocation creates a retained
subdirectory containing copied inputs, tool/source hashes, per-case model/config,
exact command, raw log, trace, counts, elapsed time, exit and classification.
Warnings, unexpected diagnostics, wrong named properties, malformed counts,
parser/tool failures and timeouts get no proof credit. A TLC temporal property
containing a safety conjunct can report exit 12 with an invariant diagnostic;
a liveness violation reports exit 13. NoStrand names its safety conjunct
`NoFailWhileOtherAllowed`, so that exact component diagnostic also identifies a
NoStrand failure. Other property names or source-location diagnostics are rejected.
Counts are informational and may differ between JVMs. Fingerprint collisions
remain possible. Historical failed attempts are retained without reclassification.

`matched` compares the result to the case's original expectation. A named failure
of a Target pass case records `design_finding=true`, keeps `matched=false`, and
makes the process nonzero. `invalid_runs` separately identifies parser, timeout,
wrong-property and other unclassified failures. The combined Target.cfg is run
unchanged, followed by isolated property cases so the first error cannot conceal
later findings. No CI or product/Bun test result follows from this runner.

## Properties and sensitivity

| Property | Checked effect |
|---|---|
| NoFailWhileOtherAllowed | At a request's terminal rejection, all accounts must have rejected relevant true quota. Disabled, excluded or cooling accounts still count as quota-allowed alternatives; those routing restrictions can cause a design failure. |
| NoKnownRejectedFirstTry | The hub's first selection must not have a relevant rejected meter in its latest fresh passive observation. Retry selections are separate. |
| FablePreference | Cold/rebound Fable selections must choose A when both accounts' relevant observations are fresh and A's observed weekly/Fable meters allow it. Existing bound hits are exempt. |
| SoonestResetFirst | Cold/rebound Other selections with fresh weekly observations must choose an observed-allowed account with earliest observed weekly reset. Fable's configured preference takes precedence. |
| NoStaleAsCurrent | At rendering, neither a usage.json window nor status window may be called current when its actual observation age is stale. Render uses stored observations plus age, never true quota. |
| NoFalseActive | Published active candidates must have a fresh weekly observation or an actual binding. Render also ages an already-published active flag. |
| SingleWriter | Count the old fable writer, steer and new controller across handover; at most one is enabled. |
| NoStrand | Pending/in-flight requests eventually serve or legitimately reject; killing a request is not success, and a rejection with a quota-allowed alternative is forbidden. Restart can therefore falsify it. |
| ConvergesWhenFresh | If observations eventually stay fresh, each live non-preferred binding eventually clears or moves to the observed preferred account. |

The failure-enabled convergence case remains the primary Target check. A separate
`convergence-reliable` environment allows successful disable/enable responses only;
it checks the **same** property. Its release-disabled control must fail while that
reliable baseline passes, proving that release affects convergence. This does not
repair or replace the failure-enabled result. Effect mutants leave the old writer
running at handover, remove render-time aging, or admit stale active candidates;
each must violate its designated otherwise-passing property.

Required negated witnesses reach the exact incident, AUTO retaining exclusions,
stopped-sidecar exclusions, a terminal WAIT_AT_CAP quota failure, disable failure,
enable failure, release during a
request on that exact account, reload in flight, restart killing a flight, and
meter reset while a binding's TTL is still live, and completion of the exact
request whose account was released. Their expected failures prove
reachability, not safety. No unused-for-16-hours duration theorem is claimed.

## Bounds and environment

Two accounts, Fable and Other, two independently stored meters/account: `7d` and
`7d_oi`. Fable uses both; Other uses weekly only. Statuses are allowed,
allowed_warning and rejected, with unknown reserved for missing observations.
Use advances allowed to warning, warning to rejected. Initial meters are warning;
initial weekly resets are A=2 and B=1. Each meter resets independently to allowed
and a later reset of 3. One external-use event, one reset, two reset-clock ticks,
one real idle expiry, one reload, one restart, at most two sequential requests,
and two legacy mode/spill changes. There is no arbitrary transition-count cutoff.

One representative provider/session has **separate model keys** for Fable and
Other, standing for provider::sessionID::model. Initial keys are cold or bound to
B. A hit slides its model TTL; an idle expiry requires a live TTL and clears it.
An active session with no idle interval never expires. Reset-clock progress,
observation aging and idle expiry are independent actions. A reset therefore can
occur with a live binding. Age is per account **and meter** and saturates at stale;
traffic refreshes only the selected account's relevant meters, including 429
observations. Other traffic cannot freshen the Fable-only meter. No management
poll capable of manufacturing fresh upstream readings is modelled.

`Publish` stores observation-derived candidates and window labels. The proposed
Target renderer re-evaluates age when consuming saved labels/active flags; an old
payload cannot remain current simply because it was published while fresh. This
is a required consumer contract for usage.json and status, not a claim the source
at this baseline implements it. Current ignores observation age, computes active
by priority then observed reset then deterministic account order, and can display
an idle account as active. True quota is never used to compute displayed values.

Both versions use the **same** affinity-first hub selector, then maximum global
priority and deterministic account order, respecting persisted exclusions,
disabled status, model cooldown and retry exclusions. Three additional retries
are allowed; exhausted candidate pools can fail earlier. Dispatch freezes the
account in `flight`; Finish evaluates its actual outcome and refreshes passive
observations. Cooldown starts on a model rejection and ends independently, even
if a meter reset happens first. Cooldown/disabled fields are management-visible
reads, not live quota or allowance oracles. No direct Target routing shortcut exists.

Current OFF clears priorities/exclusions at Replan. ON persists the Fable partition;
when A's observed Fable meter rejects and spill is off/unconfirmed-auto, B stays
excluded. The hub **tries**, receives 429, retries and can terminate rejected;
there is no fictitious admission wait. AUTO throws/no-writes, leaving the last
ON fields intact. Stopping the sidecar and setting manual priority also leaves
exclusions intact. Spill auto confirmation remains unconfirmed in this bounded
projection; manual on/off alternatives are present.

Target starts with steer explicitly disabled and one old fable writer. Its atomic
handover stops the old writer and enables the new controller. Old OFF writes may
precede handover. The new controller ranks observed-allowed weekly accounts by
observed reset and excludes Fable from B while A is believed usable for Fable.
It excludes fresh observed rejection/cooldown per model. Priority is global and
never depends on the pending request kind. Neither handover nor observation
refresh creates an atomic replan/admission barrier. That gap is intentionally
checked, rather than hidden behind an initialization assumption.

ReleaseDisable and ReleaseEnable are distinct PATCHes with independent success
or definitive failure. Failed disable leaves bindings; successful disable clears
only that account's bindings and marks it disabled. Failed enable leaves it
disabled. Neither operation edits an in-flight request. No automatic retry or
rollback of failed release is assumed. Ambiguous commit-after-failed-response is
outside this projection. ConfigReload drops all bindings and preserves in-flight
work. Restart drops bindings, wipes passive quota readings and kills an in-flight
request. The quota held by the upstream account itself survives restart.

Scenarios are explicit finite projections to keep TLC below 90 seconds: `routing`
(and `incident`) allow all bounded environment events and release/restart;
`known` retains response/retry/cooldown/second-request events; `telemetry` retains
independent aging and publication; `handover` retains old/new writes; `progress`
retains release, external use, reload and restart; `release` retains two PATCHes,
reload and restart; `release-no-restart` checks the same request-lifetime
property with successful in-flight completion under both PATCH outcomes and no
process kill; `restart` isolates the real lost-request counterexample; convergence scenarios freeze fresh observations, keep a live
binding and have no traffic/expiry that could clear it instead of release.
Shared request, publication and controller actions remain in each scenario.
Passing projected cases are not proofs over the union of every possible event.
The combined unrestricted Target check fails and is NOT_GREEN.

Weak fairness is assumed for hub dispatch/completion, handover, replan and the
release attempt. It does not guarantee a PATCH succeeds. Clock progress, external
use, idle expiry and reload/restart have no fairness assumption. No wall-clock
latency bound, retry transport correctness or unlimited-session theorem follows.

## Transition binding and evidence boundary

Source lines refer to the baseline sources hashed by the runner. They were read;
there is no executable conformance adapter. Upstream internals below are supplied
A0 recon, **read from upstream source v8.0.80, not tested live**, not an independent
inspection of that source by this implementer.

| Action / element | Source binding or explicit environment assumption |
|---|---|
| Init, Relevant, meter use in Finish | `src/fable/core.ts:163-189,201-238,249-270`: distinct weekly/Fable meters, rejected status, usability. Discrete use is an accounting abstraction. |
| Dispatch, retry in Finish, NextRequest | Supplied upstream affinity/fill-first/quota-rebind/retry semantics. M1 config routing block `/opt/homebrew/etc/cliproxyapi.conf:18-27` was read only: fill-first, affinity true, TTL 1h, subagents true, rebind-on quota, request-retry 3, max interval 30. Tie order is a deterministic two-account abstraction. |
| Age, Publish, RenderedCurrent/Active | `src/usage/snapshot.ts:40-69`, `src/usage/projection.ts:22-35,66-73`; observations, priority/reset active prediction, baseline stale:false on a successful management read. Target per-window age/render filtering is proposed. |
| ResetClock, Reset, ExternalUse | Upstream environment events; `src/fable/core.ts:224-238` reset interpretation. No management read refreshes a passive upstream observation. |
| Expire / sliding key TTL | Supplied upstream in-memory provider::sessionID::model key; one-hour sliding TTL. Bound affinity spans priority tiers; priority changes do not move it. |
| Replan / ModeChange | `src/fable/core.ts:270-285,310-333,353-355,375-408`; OFF/ON/disabled AUTO, unknown fallback, cap/spill partition. `src/fable/main.ts:112-139,258-277,313-321` reads/applies/repeats at 30 seconds. Per-account hub writes are projected atomically except explicit release PATCHes. |
| SteerStart / SteerWrite | Separate writer admission; `src/steer/rank.ts:97-113`, `src/steer/steer.ts:41-83`, `src/steer/loop.ts:15-51`. Disabled in Target; no live daemon state is claimed. |
| StopAndManual | Brief's stopped-sidecar/manual-priority procedure. `src/fable/off.ts:43-104` is an explicit restore, not a shutdown hook; stopping alone does not call it. |
| CooldownEnds / rejection cooldown | `src/fable/core.ts:240-247,249-270`; management model-level-cooling observations plus supplied upstream quota-rejection selection behavior. Durations are abstract. |
| Handover | Proposed stop-old/disable-steer/enable-new operating contract, one action; old/new overlap is tested by a dedicated mutation. No process-installation enforcement proof. |
| ReleaseDisable / ReleaseEnable | Supplied upstream PATCH /credentials/status disable-then-enable removes one credential's bindings, not in-flight work. No management release endpoint exists. Failures are model environment responses, not observed live failures. |
| ConfigReload | Supplied upstream hot reload of any routing field drops all bindings but preserves in-flight work. CURRENT controller never uses it as a release workaround. |
| Restart | Supplied upstream process lifecycle kills in-flight work; `src/fable/core.ts:195-199` records that all passive weekly readings disappear after restart. No service restart was run. |

RESERVE_CONFLICT (`core.ts:296-307,396-398`) is explicitly out of scope: modelling
its non-Fable estimate requires correlated weekly/Fable utilization fractions,
reserve margin and thresholds beyond the three-status quotient. That numeric
state expansion is deferred to keep each configuration within 90 seconds; the
present model does not certify reserve policy. Historical quota estimates,
recovery, strict partitions, arbitrary model aliases, additional providers, API
keys, multi-session contention, filesystem durability and arbitrary partial
priority/exclusion writes are also excluded. These limits do not license deleting
tests or claiming C1 installed/live correctness.
