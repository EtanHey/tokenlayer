# Rotation candidate — current process-crash abstraction

Run `python3 formal/history-rotation/check.py --out <new-or-existing-evidence-directory>`.
Each invocation creates a fresh retained run; no evidence cleanup, installs or downloads.
Configs are generated from `checks.json`, saved separately with model copies and raw TLC
traces. The runner pins Java/JAR identity and hashes Bun, source, model, configs and logs.
Limits: one worker, 512 MiB heap, 90 seconds/config, 900 seconds/invocation, 4 MiB/file.
Wrong-property violations, parser errors, warnings, timeout and missing states fail closed.

## Source map and abstraction

| Actions / state | Current source join | Meaning |
|---|---|---|
| Scan / torn / pending | journal.ts:77–90; stream.ts:78–90 | Reconcile complete records; torn tail refuses before rotation/terminal append. |
| Prepare / DirSync | journal.ts:37–47 | Safe directory and cap/permission admission projected into refusal; sync parent before replacement. |
| Write / Flush | journal.ts:47–48 | Separate successful full replacement write and fsync. |
| Prepare snapshot / Link / AuditSync | journal.ts:47–52 | Independently require retiring inode/image before observing actual alias publication and sync. |
| Rename / ParentSync | journal.ts:53–54 | Active alias switches to replacement, then parent fsync. |
| Restart / Shared | journal.ts:36,49–50; stream.ts:90 | Completed filesystem operations survive process death; detect shared active before reconcile append. |
| Settle / AppendRecord | stream.ts:91–94; journal.ts:56–62 | Zero→retry, full→acked, partial→refuse; append refuses shared inode. |
| TrySharedAppend / NewIntent | journal.ts:56–62; stream.ts:175–183 | Direct guarded API attempt and next batch's pending append. |
| Crash / Refuse | tests/support/history-rotation-child.ts:6–12 | Kill projected between completed operations; I/O refusal at operation boundaries. |

Bytes are sequences of terminal `t`, pending `p`, terminal append `a`. `resolved` tracks
the current obligation; retained old `p` bytes remain historical after its terminal record.
Inode identities 0–2 hold distinct byte sequences; `required` tracks preparation obligations
independently of `audit`; `saved` captures the required image once, never re-baselined by
recovery/relink. At most two completed rotations, one process crash, one subsequent intent
(explicit NewIntent bound), one pending obligation at a time, zero/full/partial, optional torn input. Initial
active is assumed above the rotation threshold; replacements are below it. This is a
bounded projection, not an induction proof for arbitrary cycles or multiple pending tokens.

| Property | Reachable antecedent | Dedicated defect |
|---|---|---|
| AuditImmutable | hardlink | damage-audit mutates linked old bytes |
| RetiringInodePublished | rename / second generation / recovery-published | missed-link-first/second, wrong-inode-second, relink-changed |
| PendingReachableAfterCrash | crash-parent-sync | drop-pending omits pending replacement |
| NoAppendToArchivedInode | direct-append/shared-refusal | append-shared bypasses guard |
| RefusalPreservesRetainedBytes | io-refusal | truncate-on-refusal changes retained bytes |
| TornNeverConsumed | torn-refusal | consume-torn accepts torn input for reconciliation |

All six properties run alone against dedicated mutants, then together against current protocol.
Publication requires every prepared inode that lost its active pathname to have an actual
audit alias AND the original required bytes, even when the alias was never created. Rename
is not guarded to make this true. Missing/wrong-link controls preserve the hardlink event;
the second-generation controls must reach active inode 2. Relink-changed corrupts shared
bytes before recovery; the preparation snapshot must remain unchanged until publication.
Reachability is checked with separate expected `WitnessAbsent` counterexamples, including
every crash boundary, successful second generation, recovery and terminal refusal paths.
`TornNeverConsumed` means no reconciliation action from torn input; `records()` can yield
complete prefix records before detecting a torn tail. Refusal preserves bytes present at
that boundary; earlier successful writes/links may remain. No rollback guarantee is modeled.

## Evidence boundary and remaining obligations

Safety uses stuttering and no fairness; no liveness property is claimed. Eventual success
would require fair local scheduling, terminating successful I/O/coverage, adequate space,
no more crashes, a cooperative single writer, and non-torn/non-partial input; NOT_CHECKED.
Process death preserves completed syscalls. Host-power-loss durability is NOT_CHECKED:
separate volatile/durable namespace/content states and an accepted filesystem contract are
needed. `src/ship/state.ts:40–50` lacks parent-directory fsync; no checkpoint power-loss
guarantee follows from rotation's directory syncs. Partial writes, interrupts inside a
syscall, hostile external writers, serialization/path/privacy, capacity and CH are excluded.

`conformance.ts` executes real AuditLog/StreamingHistoryClient on retained synthetic files:
shared refusal, shared-inode recovery, zero/full/partial coverage, repeat rotation, immutable
bytes and torn refusal. Every recovery and repeat rotation captures retiring dev/inode+bytes
and requires a matching actual audit pathname. Coverage/space injected; no service/statfs.
Copied source mutants remove append's shared guard or exactly omit the review's linkSync
statement; each must fail its specific assertion, with wrong-target controls rejected.
This is sampled source binding, not generated graph-edge conformance. Remaining: export and
drive every modeled filesystem edge with actual operation hooks; bind fsync/rename ordering
and further source mutants; independently review model-to-code fidelity and repeatability.
The two existing rename-side SIGKILL integration witnesses remain unchanged and required;
they are NOT_RUN by this self-contained checker. No test removal is licensed by this slice.
