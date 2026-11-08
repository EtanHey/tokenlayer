# Bounded importer protocol (S0/S1)

Status: model/checker bound to current source (`RecheckStop=TRUE`); sampled S2 code binding lives in `formal/history-conformance/`. No existing tests may be removed on this evidence. No runtime, CI, ratchet or data changes.

Run from the repository root with Python 3 and the existing, locked local Java/jar:
```sh
python3 formal/history/check.py --self-test
python3 formal/history/check.py --out /outside/repo/private-evidence
```
`--case NAME` is a diagnostic partial run, not the full acceptance gate. `checks.json` enumerates seven desired safety targets and dedicated mutants, no-failure progress/stall, and twenty-two reachability probes. `current-safety` checks all seven expecting PASS under `RecheckStop=TRUE`, the current source profile; mutants, progress/stall and reachability use that profile too. `historical-stop` (`RecheckStop=FALSE`, pre-guard base `d737a6e`) must violate StopBeforeDispatch: retained historical evidence and the discriminator for the recheck, not a current-source result. Receipt classifications distinguish these outcomes; full-suite completion means every expected outcome occurred. Each mutant selects its intended property, requiring the precise TLC error and exit (12 invariant, 13 named temporal violation). Parse/tool/timeout/wrong-property failures refuse acceptance. Reachability deliberately violates `WitnessAbsent`; these are existential witnesses, not additional safety guarantees.

## State and bounds

One pinned source/generation, two nonempty keys, contiguous batches {1}, {2}, {1,2}, and at most one abrupt process death. Exceptions/restarts may cycle in a finite state graph. `cp` is persisted acknowledged progress, `wa` durable write-ahead progress, and `acknowledged` a ghost high-water mark of successful ACKs. Reconcile-full records ACK without moving `cp`; reset precedes selecting a possibly different partition. Pending partial coverage halts with its prior ledger status retained; fresh partial overlap may dispatch the entire new batch. `stored` is a logical FINAL key set, never a physical insert count. `wire` preserves delayed server work across client death but collapses identical key sets; it is not a physical request ledger.

Apply nondeterministically commits zero/partial/full keys under `Faults=TRUE`, an overapproximation of uncertain server outcomes, not evidence that ClickHouse makes arbitrary partial commits. Successful responses require full key coverage. External loss is allowed only before final acceptance, exercising the actual final-count gate; accepted receipts are not promises against later database deletion. Crash assumes completed writes survive **process death**. Torn I/O, host power loss, hashes/bytes/Unicode, blank tails, full multi-source/pilot sequencing, epochs/capacity, ledger rotation, distributed ownership and error-rendering custody remain outside this first projection. Admission/source identity checks are assumed successful; no invented distributed fence.

Safety allows stuttering and assumes no fairness. Progress disables crashes, exceptions, stop, partial apply and external loss; it assumes successful admission, stable pins and weak fairness of enabled client `Work` and server `Apply`. Its claim is eventual acceptance for this two-key source, without a time bound. Stall disables checkpoint continuation and must violate that same temporal property. It does not prove recovery progress under permanent refusals.

## Source joins and sensitivity

| Action / checked property | Current implementation join | Required broken config |
|---|---|---|
| Prepare / write-ahead vs checkpoint | `src/ship/ship.ts:315-327,338,356-357` | early-checkpoint |
| Intent + Send / IntentBeforeDispatch | `scripts/history/stream.ts:163-183` | no-intent |
| Reply + Ack + Checkpoint / CheckpointAfterAck | `stream.ts:181-188`; `ship.ts:321-327` | early-checkpoint |
| Reconcile / PartialPendingStops + PartialPendingCustody | `stream.ts:78-95`; `run.ts:112-119` | partial-continue (exact reset continuation), partial-ack (terminal custody loss) |
| Reconcile + Reset / RecoveryDoesNotCheckpoint | `stream.ts:91-95`; `scripts/history/run.ts:112-119` | recovery-commit |
| GuardThenAwait + RequestStop + Stop / StopBeforeDispatch | `stream.ts:163-178` (recheck 176-178); `run.ts:225-230`; `source.ts:115-116` | historical-stop (RecheckStop=FALSE), ignore-stop |
| Accept + RefuseFinal / AcceptanceRequiresFinal | `run.ts:152-173` | accept-mismatch |
| FairSpec / EventuallyAccepted | Finite abstraction under the assumptions above | stall |

R1 correction to the original S0/S1 claim: the final stop guard is followed by a conditional `await reconcile()` at stream.ts:171-173. Terminal ledger history is read asynchronously. GuardThenAwait requires cp=1 and an acked prior ledger, passes the guard, and permits stop during that wait. Branch selection is nondeterministic: exact capacity/rotation internals remain excluded. At base `d737a6e` nothing rechecked stop after that await, so Intent/Send continued: the `historical-stop` counterexample, retained as history and never as a production incident. PR133 (`5f57536`) added the recheck at stream.ts:176-178, which this model already expressed as `RecheckStop=TRUE`: guard-wait with stop admits only Stop→halt. That is now the current profile. Real-code binding of both directions is in `formal/history-conformance/`; OS-signal reproduction is NOT_RUN. The frozen original implementation/review remains unchanged.

RequestStop excludes the synchronous intent-to-dispatch interval, but includes guard-wait. A dispatched request can finish after stop. PartialRecoveryStep observes the actual Reconcile transition; independent sticky monitors require next pc=halt and the entire pending ledger unchanged. They do not trust event strings. The partial-continue mutant assigns pc=reset unconditionally, exactly matching review A's challenge; partial-ack changes terminal status and independently fails custody. `reach-partial-effects` witnesses halt with partial coverage and retained pending custody; `reach-terminal-await-stop` witnesses the stopped terminal-history wait. An explicit Restart means externally authorized resumption after lock disposition; the model never reaps a lock. Latest intent/terminal state abstracts the cumulative ledger; append/fsync and checkpoint replacement are atomic completed operations here. Failure assumes ambiguous recording succeeds; individual disk-write failures are deferred. ACKs/checkpoints are eagerly separated into steps, not a proof of every batching/save schedule.

## Runner/evidence boundary

The local toolchain lock is a reproducibility pin, not a download URL or portable installer. Java version and executable hash, jar hash, model/config/runner/source hashes and argv are recorded. Child Java settings ignore inherited Java option variables. Each invocation uses a fresh retained directory and snapshots authored inputs; each config has its own module/state directory to prevent TLC timestamp-named trace exports colliding. No cleanup. One TLC worker, heap 512 MiB, per-config deadline 90 seconds, shared 900-second budget, and 4 MiB per-child-file limit (logs and TLC state files). No full graph dump; counterexample traces are retained. A limit hit is incomplete/error evidence, never an expected mutant. Deadlock checking is off because explicit refusal/done states and stuttering are intentional; progress is checked separately.

Unexpected outcomes stop the invocation and mark remaining cases NOT_RUN. Individual successful/expected-red rows do not establish full completion. Source/tool drift refuses completion. No code is extracted from TypeScript: these are manually joined protocol abstractions. Lead-routed independent model review precedes S2's real-code replay/mutation sensitivity, then any D1 replacement decision. Real SIGKILL, CH/SQL, filesystem, byte/privacy and parser tests stay intact.
