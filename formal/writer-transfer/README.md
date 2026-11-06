# Writer transfer: current counterexample and conditional procedure

Status: R1 MODEL_ONLY, final R2 review pending. No product enforcement or test replacement.
`Current.cfg` is expected to violate `GlobalSingleDispatcher`: two independent local
parents can both acquire locks and dispatch. This limitation remains NOT_GREEN.
`Conditional.cfg` checks a PROPOSAL_ONLY external cooperative procedure, not current app code.
There is no shared hub fence, receiver-enforced lease, or implemented generation check.
`SourceStop.cfg` also retains the source-derived callback-level stop counterexample.

Run `python3 formal/writer-transfer/check.py --output /absolute/new/receipt-directory`.
The runner pins the existing jar, records Java/model/config/source hashes and exact commands,
uses one worker, at most 512 MiB heap, 90 seconds/config and 900 seconds/invocation.
Each immutable attempt retains logs/configs/model copies/traces; no downloads or cleanup.
Exit zero means the expected receipts matched, including current product counterexamples.
Warnings reject every outcome before classification, including named expected counterexamples.
Eleven saved synthetic probes include warning+success/exit0, warning+invariant/exit12 and
warning+temporal/exit13. Wrong-property, parser/tool errors and timeout exits also fail.
No Bun/product tests run; historical warning-bearing/failing receipts are not regraded.

## Transition binding and external assumptions

Source paths are relative to the repo. Source hashes are in each run's `identity.json`.

| Model transition | Source or proposed procedure; enforcement gap |
|---|---|
| Current Acquire / Cleanup | `scripts/history/run.ts:46-69,183-191`: canonical local parent, exclusive create, owned cleanup; cooperative pathname identity, no hostile replacement. |
| Current Dispatch / Finish | `src/ship/ship.ts:315-327` awaits insert; `scripts/history/stream.ts:176-185` intent before HTTP and terminal ledger after. One batch/process; local locks do not serialize other machines. |
| Transfer Request / Observe | External request versus explicit TRUE `shouldStop()` poll at `stream.ts:115-116,163-164`. Observe is not callback visibility. This proposal abstracts out the post-poll await; its narrow NoPostStopDispatch target gives no callback-level source enforcement credit. |
| DispatchOld / Finish | `stream.ts:176-185`, README:17: admitted batch may finish after observed stop. `Finish(FALSE)` means independently established remote completion with unresolved ledger outcome; a timeout or lost reply alone cannot remove outstanding work. |
| Classify(FALSE/TRUE) | `stream.ts:78-95`: full/zero coverage terminal reconciliation; partial/unknown stays unresolved. TRUE is an external explicit HOLD with exact retained ledger/checkpoint custody. Receiver retry exclusion for held keys is an external promise; no key universe or retry transition exists here to prove it. No byte/durability proof. |
| Quiesce / Release | Proposed procedure: observe stop, establish no dispatched remote work, terminal reconciliation or explicit HOLD, disable every old dispatch/restart capability, complete local cleanup, then release. No executable shared revocation exists. |
| Ack / Accept / DispatchNew | Proposed lead/receiver procedure: match release and acknowledgment to the current handoff/old incarnation, verify custody and quiescence, then acquire an uncontended receiver-local lock and admit. Integer generations are documentary identities, not a hub token. |
| Crash / Restart | Process crash retains lock, outstanding work and intent. Restart abstracts independently verified exact stale-lock disposition plus reacquisition; it resets stop observation and increments identity. Absence never establishes remote quiescence. Restart is allowed before revocation only; after release the external promise forbids old dispatch/restart capability restoration. |
| StaleRelease / StaleAck | Delayed messages from a prior incarnation are injected after restart. They do not qualify current acceptance; a later current release can replace a stale one. No production message channel is claimed. |

These guarantees require a complete two-owner inventory and cooperative operators/processes.
Unknown prior writer (`Known=FALSE`) prevents transfer even after process crash; it is HOLD.
The current local-lock model has no external assignment in Init or Next. The conditional
guards specify human/lead obligations; they are not evidence that the app enforces them.

## Callback visibility versus polling and the source await gap (A1)

SourceStop separates external Request, Signal (the `run.ts:224-226` callback sets
`stopping`) and PollAndStart (explicit `shouldStop()` result). A false poll at
`stream.ts:163-164` can be followed by conditional `await reconcile()` at 171-173.
Reconcile's async ledger scan at 78-82 can yield even with only a prior terminal batch.
There is no subsequent stop poll at 175-180: `verifySource` checks identity at
`source.ts:115-116`, and its `run.ts:108-110` wrapper checks state size, not stop.
SourceStop reaches first batch finish, terminal ledger, false poll, await, callback,
resume and a new dispatch: NoPostSignalDispatch fails while NoPostPollDispatch passes.
An already-dispatched batch finishing after callback is allowed and is not that violation.
This is a source-derived scheduling abstraction, not an actual signal incident/reproduction
or complete source conformance. It deliberately covers one live incarnation and terminal-ledger
await; earlier async checks, failed I/O and partial recovery are outside this projection.
ProposedStop's `callback-guard` adds a recheck on resume; it passes the desired callback
target and reaches stopped-at-resume. That recheck is unimplemented, PROPOSAL_ONLY, or
must be supplied by an equally strong external serialization obligation. Request, process
absence and a stale false poll never establish callback-level dispatch quiescence.

## Property sensitivity and reachable antecedents

Each baseline safety property is checked with its own named defect control. Reachability
configs negate a witness predicate; their expected named invariant violation proves a witness.

| Property | Dedicated defect / witness |
|---|---|
| LocalExclusive | `local`: bypass same-parent exclusion; WitnessLocal reaches lock ownership while same-parent contention is refused in baseline. |
| GlobalSingleDispatcher | Current unfenced counterexample; `drain` transfers while a batch remains outstanding; `stale` also admits old/new overlap. WitnessLateFinish proves observed stop with old work still able to finish. |
| NoPostStopDispatch | `stop` admits another dispatch after an explicit TRUE poll; WitnessStopped. Narrow poll-level target only. |
| AdmissionQuiescent | `capability` releases without revoking old dispatch/restart capability; WitnessAccepted. This checks capability revocation; GlobalSingleDispatcher separately checks outstanding batches. |
| CustodyRetained | `custody` drops held pending custody at acceptance; WitnessHeldTransfer reaches a valid accepted transfer with unresolved intent explicitly held. |
| NoIntentDiscard | Independent TrackCustody latches acceptance's effect on a previously pending intent. Exact `clear-both` Accept mutation clears pending and custody; the historical state invariant loses its antecedent but this monitor must fail. It does not forbid the mutation. WitnessSuccessfulHeldHandoff reaches retained held intent, fresh acceptance and new dispatch. |
| NoPostSignalDispatch / NoPostPollDispatch | SourceStop's existing source await path violates the callback target; ProposedStop supplies the separate proposed recheck. `poll` bypasses a TRUE poll and fails the narrower target. WitnessAwaitGap and WitnessProposalStop observe actual post-await effects. |
| FreshAcknowledgment | `stale` accepts a prior-incarnation acknowledgment before current release; WitnessRestart, WitnessStaleAck, WitnessStaleRelease and WitnessDelayedAck. |
| HandoffProgress | `lost-message` permanently prevents acknowledgment; WitnessAccepted reaches admission. Temporal control must specifically violate HandoffProgress. |

Safety has no fairness and allows stuttering, message delay, process crash and one restart.
Bounds: three local contenders across two parents in Current; one old and one new writer,
one old outstanding batch/intent, one handoff, two old incarnations and one prior message
identity in Transfer. Batch cycles are repeatable; no arbitrary step bound. The receiver's
post-admission work is terminal in this projection. No unbounded/multi-transfer theorem.
WitnessUnknownHold reaches an absent old process with remote work still outstanding.
The monotone lostIntent monitor records acceptance loss independently of current pending;
it specifically covers acceptance effects, not arbitrary corruption of every transition.

FairSpec separately excludes crashes, failed/unknown outcomes and stale delivery, and assumes
Known=TRUE plus weak fairness of request, observe, successful completion/reconciliation,
quiesce, release, successful ack delivery and admission. Held custody is also permitted.
It proves eventual acceptance only under those assumptions, with no time bound; inaccessible
owners, permanent message loss, partial/unknown recovery, or restored old capabilities are excluded.

No host power loss, filesystem durability, CH correctness, key reconciliation algorithm,
source/code conformance adapter, production/native/runtime qualification or test deletion is
proved. Existing tests remain. A future hub-validated fencing design is a separate product
proposal and implementation, with no enforcement credit from these conditional results.
