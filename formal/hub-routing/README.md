# Hub routing — MODEL_ONLY, TARGET PROPOSAL

Current deliberately fails; Target describes a proposed contract, not an installed
controller or a proof about the hub binary. Independent Claude review is pending.
No hub requests, credentials, ClickHouse access or product changes are involved.

Run from the checkout:

```
python3 formal/hub-routing/check.py --output "$PWD/.local/receipts-t1"
```

This Mac's default cache jar differs from the inherited pin. For this implementation
run, an exact matching jar was copied from M1 into `.local/tla2tools.jar` (no cache
replacement); add `--jar "$PWD/.local/tla2tools.jar"`. The runner rejects mismatched
jar, Java binary or version. This Mac has Homebrew Java 26.0.1; the inherited
backup-before-delete pin was Java 27, so this folder pins the actual local
binary independently. It installs/downloads nothing. Retained failed attempts are
not reclassified as passing attempts.

One worker, 512 MiB heap, 64 MiB TLC default offheap, 90 seconds/case,
900 seconds/invocation; fixed seed 1 and fingerprint polynomial 0. Each invocation
retains a new directory, copied model/config/runner/pins, source hashes, tool
identity, raw logs, traces, exact commands, elapsed time and exit codes. Exit 0
means every expected result matched, including Current failures; exit 1 means an
unmatched case, pin/parser errors are nonzero, and timeout receives no credit.
Warnings, unexpected error/exception diagnostics, wrong named properties, malformed
counts and wrong exits fail classification. Synthetic classifier probes are retained.
Fingerprint collision risk is not zero. No CI or installed/live-green claim follows.

## Bounds and scheduling

Two accounts, two separate meters per account (`7d`, `7d_oi`), three meter states:
allowed, allowed_warning, rejected. Fable requires both meters; Other requires
weekly only. Each meter has its own reset time. Earliest-reset policy compares the
weekly reset for both request classes, with account order breaking ties. This is
an explicit policy choice; it does not minimize the separate Fable meter reset.

One representative provider (Claude) and session, with **separate model keys** for
Fable and Other, stands for provider::sessionID::model. There are at most two
sequential requests, with the second choosing either model. An initial Fable key
may be cold or bound to either account. Tick means an idle TTL interval has elapsed;
it expires both model keys. Every admission/hit renews its key, so a continuously
active key with no idle Tick remains bound forever. TTL is one abstract hour, not
30 seconds. Meter clocks have two ticks (initial resets 1/2, reset moves to 3).
There is one external-use event, one reset event, one restart, one targeted release,
and one legacy mode/spill change. There is no arbitrary step cutoff; Observe,
Replan and request actions can repeat. Meter use advances warning to rejection;
reset makes allowed and subsequent use makes allowed_warning.

Dispatch and completion are separate: `flight` freezes the selected account while
pc=inFlight. Reset, mode changes, restart and ReleaseBindings may interleave with
it; clearing a binding never edits `flight` or discards the request. Retry after
quota rejection clears only that model binding and excludes the rejected account
from the current request. Current has three additional retry attempts; the finite
two-account pool can exhaust earlier. Target selects an actually allowed account
or refuses only when none is allowed. A rejection during flight can still cause a
retry. Fairness of admission and completion excludes permanent worker/network
failure. Release is weakly fair when continuously enabled. No finite latency bound.

Current explores OFF/ON/AUTO and off/on/auto spillover, explicit zero-reset
confirmation, competing fable/steer writers, and stopped-sidecar/manual priority.
AUTO is an error/no-plan state, because source disables it. WAIT_AT_CAP suppresses
admission while Fable A is capped and spill is not enabled. Target removes the
legacy mode and spill knobs, so their inert combinations are normalized in Init;
there is one writer, no cap wait, Fable A preferred while usable, earliest weekly
reset otherwise. Bound hits outrank priority until release, quota failure or idle
expiry. `ReleaseBindings(acct)` represents disable/re-enable of the departed
account, abstracted atomically; it clears every model key for that account.
Restart clears all keys. Transient disable, PATCH failure and restart interruption
of a network request are excluded. Those require additional product integration
proof before this proposal can be implemented safely.

The model deliberately assumes an allowance oracle for Target admission and reset
times. Real passive telemetry can be stale and cannot supply that oracle. Thus
Target's NoRejected guarantee is conditional on a validated admission view (and
permits rejection if external use changes allowance after dispatch). This is a
specification obligation, not evidence a polling controller can enforce it.

## Properties and named Current counterexamples

| Property | Meaning / Current trace |
|---|---|
| NoRejectedWhileOtherAllowed | At dispatch, never select an actually rejected relevant meter if another account is allowed; Current retains a sticky or priority-selected rejected account after external use. |
| NoStrand (temporal) | Every pending/in-flight request eventually terminates, and refusal requires all accounts rejected at that decision. Current ON + no spill + A Fable rejected stutters forever in WAIT_AT_CAP while B is usable. |
| NoStaleAsCurrent | A positive observation age must not be labelled current. Current Tick retains the current flag; Target marks it stale until Observe. |
| FablePreference | Cold/rebound Fable goes to A whenever A is allowed for both meters. Current OFF or ON priority plus a cold/rebound key can choose B. Existing valid bindings are exempt. |
| SoonestResetFirst | Cold/rebound unpinned requests go to the allowed account with earliest weekly reset (except usable configured Fable A). Current priority can prefer the later reset. |
| SingleWriter | At most one enabled priority writer. SteerStart enables a second independent writer alongside fable; manual takeover stops both first. Atomic writes still interleave, so this is ownership exclusion, not simultaneous CPU execution. |

`Current.cfg` lists all properties; TLC stops at the first violation. The runner
projects it into one named property per case, so all six counterexamples are
required independently. `Target.cfg` checks all properties together. These are
bounded model results, not a theorem for arbitrary sessions, unbounded use,
unknown accounts, 5h limits, model aliases, API-key credentials, network failures,
process crashes during requests, partial management writes or live quota behavior.

## Transition binding and assumptions

Paths/lines below refer to the baseline source hashed by the runner. TypeScript
sources were read; no executable source conformance adapter is provided.

| Action / model element | Binding and evidence boundary |
|---|---|
| Init / Relevant / Advance | `src/fable/core.ts:163-189,201-238,249-270`: independent weekly/Fable signals and usability; three statuses and two account inventory. Discrete consumption is an abstraction, not token accounting. |
| Attempt / Finish / NextRequest | Hub fill-first/priority/order, quota rebinding, retry and affinity are upstream behavior. Config M1 `/opt/homebrew/etc/cliproxyapi.conf:18-27` read via an allowlisted routing-block extraction: fill-first, affinity true, TTL 1h, subagents true, rebind-on quota, retry request-retry 3/max interval 30. No config outside that block was read. Deterministic account tie order and separate admission/completion are modeling assumptions. |
| Tick | Abstract idle time/TTL and observation aging; `src/fable/core.ts:169-185` rejects stale quota after five minutes. Abstract observation age is one stale/fresh threshold, not the affinity clock duration. |
| ExternalUse / Reset | Environment events, not tokenlayer writes. Meter reset interpretation `src/fable/core.ts:224-238`; external use may occur without updating passive observations. |
| Observe | `src/usage/snapshot.ts:45-69` emits stale:false on successful management read and computes active without checking quota observation age; `src/usage/projection.ts:22-35,66-73` retains per-meter timestamps/statuses. `src/usage/snapshot.ts:101-146` handles management-read failure separately. Target display freshness is proposed; current means displayed current, not proof of traffic. |
| Replan | `src/fable/core.ts:276-294,353-355,391-446` OFF/ON, disabled AUTO, priority partition, spill/WAIT_AT_CAP; `src/fable/main.ts:88-139,258-277,313-321` OFF restore/run every 30s; `src/fable/off.ts:43-104` null priority and exclusions even with complete catalogs. Replan abstracts successful per-account writes; no partial write proof. |
| SteerStart / SteerWrite | `src/steer/rank.ts:97-113`, `src/steer/steer.ts:41-83`, `src/steer/loop.ts:15-51`; separate process/priority writer, soonest weekly reset. Start is an environment choice, not proof both daemons are installed/running now. |
| ModeChange | `src/fable/core.ts:39-48,270-285`; requested modes/spill and explicit reset confirmation. Reserve/strict exclusions and recovery/cooldowns are outside the projection. |
| ManualOverride | Stopped-sidecar plus manual priority is the brief's incident procedure, not a controller function. Model additionally stops steer to represent exclusive manual ownership; no stop command was executed. |
| ReleaseBindings(acct) | TARGET ONLY: proposed single-writer disable/re-enable of departed account. There is no controller release today. Leaves in-flight request untouched. |
| Restart | Hub environment action clears all provider/session/model bindings; modeled binding effect only, not transport or service uptime. |

Additional A0 recon supplied by the lead is **read from upstream source v8.0.80,
not tested live** (the implementer did not independently inspect that source):

| Upstream fact | Model / assumption |
|---|---|
| In-memory binding key provider::sessionID::model; TTL slides on every hit; restart drops all bindings | Per-model maps, hit renewal, idle Tick, Restart. |
| rebind-on accepts any/quota/never; installed setting quota | Quota failure clears binding; other policies excluded. |
| Affinity checks across all priority tiers | Bound hit wins despite Replan/SteerWrite/ManualOverride. |
| No management release endpoint | Target release is the credential status workaround, not a new endpoint. |
| PATCH /credentials/status disable then enable one credential drops that credential's bindings, leaving in-flight requests untouched | ReleaseBindings(acct), atomic successful workaround assumed. |
| Hot reload of any routing config field drops all bindings; leaves in-flight requests untouched | Same binding-clearing effect as Restart; config reload aliases that transition in this projection, transport effects excluded. Neither workaround is in CURRENT controller. |

No unread binary behavior is certified by this model. The config was read, not
changed; upstream recon and the selection abstraction require live verification
and source-conformance work before implementation claims.

The runner also requires three negated reachability invariants to fail on Target:
`WitnessReleaseInFlight`, `WitnessRestartInFlight`, and `WitnessRetry`. These
observe effects, including a release on the exact account serving the in-flight
request, rather than merely enabling the actions. They show those liveness
antecedents are reachable; they are not additional safety claims.
