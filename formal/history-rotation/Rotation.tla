-------------------------- MODULE Rotation --------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS Mutation, Goal
VARIABLE s
vars == <<s>>
HasPending(bytes) == "p" \in {bytes[j] : j \in 1..Len(bytes)}
Shared == s.active \in s.audit
Rotating == s.pc \in {"prepare", "dir-sync", "write", "flush", "link", "audit-sync", "rename", "parent-sync"}
Init == s \in {
  [pc |-> "scan", active |-> 0, next |-> 1, bytes |-> [i \in 0..2 |-> IF i = 0 THEN <<"t", "p">> ELSE <<>>],
   audit |-> {}, required |-> {}, saved |-> [i \in 0..2 |-> <<>>], flushed |-> FALSE,
   auditSynced |-> FALSE, parentSynced |-> FALSE, crashed |-> FALSE, crashes |-> 0,
   torn |-> torn, coverage |-> coverage, resolved |-> FALSE, consumed |-> FALSE,
   badAppend |-> FALSE, refusalBytes |-> [i \in 0..2 |-> IF i = 0 THEN <<"t", "p">> ELSE <<>>], seen |-> {}]
  : torn \in BOOLEAN, coverage \in {"zero", "full", "partial"}}
Scan == /\ s.pc = "scan"
        /\ IF s.torn /\ Mutation # "consume-torn"
           THEN s' = [s EXCEPT !.pc = "refused", !.refusalBytes = s.bytes, !.seen = @ \cup {"torn-refusal"}]
           ELSE s' = [s EXCEPT !.pc = IF Shared \/ s.active = 0 THEN "prepare" ELSE "settle",
                      !.consumed = s.torn, !.seen = @ \cup {"scan"}]
Prepare == /\ s.pc = "prepare" /\ s.active < 2
           /\ s' = [s EXCEPT !.pc = "dir-sync", !.next = s.active + 1,
                    !.required = @ \cup {s.active},
                    !.saved[s.active] = IF s.active \in s.required THEN @ ELSE s.bytes[s.active],
                    !.flushed = FALSE, !.auditSynced = FALSE, !.parentSynced = FALSE,
                    !.seen = @ \cup {IF Shared THEN "shared-recovery" ELSE "prepare"}]
DirSync == /\ s.pc = "dir-sync"
           /\ s' = [s EXCEPT !.pc = "write", !.seen = @ \cup {"directory-sync"}]
Write == /\ s.pc = "write"
         /\ s' = [s EXCEPT !.pc = "flush", !.bytes[s.next] = IF Mutation = "drop-pending" THEN <<>> ELSE <<"p">>,
                  !.seen = @ \cup {"write"}]
Flush == /\ s.pc = "flush"
         /\ s' = [s EXCEPT !.pc = "link", !.flushed = TRUE, !.seen = @ \cup {"replacement-fsync"}]
Link == /\ s.pc = "link"
        /\ LET omit == (Mutation = "missed-link-first" /\ s.active = 0)
                       \/ (Mutation = "missed-link-second" /\ s.active = 1)
               target == IF Mutation = "wrong-inode-second" /\ s.active = 1 THEN s.next ELSE s.active
           IN s' = [s EXCEPT !.pc = "audit-sync", !.audit = IF omit THEN @ ELSE @ \cup {target},
                            !.seen = @ \cup {"hardlink"}]
AuditSync == /\ s.pc = "audit-sync"
             /\ s' = [s EXCEPT !.pc = "rename", !.auditSynced = TRUE, !.seen = @ \cup {"audit-fsync"}]
Rename == /\ s.pc = "rename" /\ s.flushed /\ s.auditSynced
          /\ s' = [s EXCEPT !.pc = "parent-sync", !.active = s.next, !.seen = @ \cup {"rename"}]
ParentSync == /\ s.pc = "parent-sync"
              /\ s' = [s EXCEPT !.pc = "settle", !.parentSynced = TRUE,
                         !.seen = @ \cup {"parent-fsync", IF "shared-recovery" \in s.seen THEN "recovery-published" ELSE "ordinary-published",
                                           IF s.active = 2 THEN "second-generation" ELSE "first-generation"}]
Settle == /\ s.pc = "settle"
          /\ IF s.coverage = "partial"
             THEN s' = [s EXCEPT !.pc = "refused", !.refusalBytes = s.bytes, !.seen = @ \cup {"partial-refusal"}]
             ELSE s' = [s EXCEPT !.pc = "append", !.seen = @ \cup {s.coverage}]
AppendRecord == /\ s.pc = "append"
          /\ IF Shared /\ Mutation # "append-shared"
             THEN s' = [s EXCEPT !.pc = "refused", !.refusalBytes = s.bytes, !.seen = @ \cup {"shared-refusal"}]
             ELSE s' = [s EXCEPT !.pc = "done", !.bytes[s.active] = Append(@, "a"),
                        !.resolved = TRUE, !.badAppend = Shared, !.seen = @ \cup {"append", "success"}]
TrySharedAppend == /\ s.pc = "scan" /\ Shared /\ ~s.torn
                   /\ s' = [s EXCEPT !.pc = "append", !.seen = @ \cup {"direct-append"}]
NewIntent == /\ s.pc = "done" /\ s.active < 2 /\ ~Shared /\ "new-intent" \notin s.seen
             /\ s' = [s EXCEPT !.pc = "prepare", !.resolved = FALSE,
                        !.bytes[s.active] = Append(@, "p"), !.seen = @ \cup {"new-intent"}]
Crash == /\ (Rotating \/ s.pc \in {"settle", "append"}) /\ s.crashes < 1
         /\ s' = [s EXCEPT !.pc = "dead", !.crashes = @ + 1, !.crashed = TRUE,
                    !.seen = @ \cup {"crash-" \o s.pc}]
Restart == /\ s.pc = "dead"
           /\ s' = [s EXCEPT !.pc = "scan",
                      !.seen = @ \cup {"restart"}]
Refuse == /\ Rotating
          /\ s' = [s EXCEPT !.pc = "refused", !.refusalBytes = s.bytes,
                     !.bytes[s.active] = IF Mutation = "truncate-on-refusal" THEN <<>> ELSE @,
                     !.seen = @ \cup {"io-refusal"}]
DamageAudit == /\ Mutation = "damage-audit" /\ s.audit # {} /\ s.pc = "audit-sync"
               /\ s' = [s EXCEPT !.bytes[s.active] = <<>>, !.pc = "refused", !.refusalBytes = s.bytes]
ChangedBeforeRelink == /\ Mutation = "relink-changed" /\ s.pc = "dead" /\ Shared
                      /\ s' = [s EXCEPT !.bytes[s.active] = <<"changed">>, !.pc = "scan",
                                         !.seen = @ \cup {"restart", "changed-before-relink"}]
Next == Scan \/ Prepare \/ DirSync \/ Write \/ Flush \/ Link \/ AuditSync \/ Rename \/ ParentSync
        \/ Settle \/ AppendRecord \/ TrySharedAppend \/ NewIntent \/ Crash \/ Restart \/ Refuse \/ DamageAudit \/ ChangedBeforeRelink
Spec == Init /\ [][Next]_vars
AuditImmutable == \A i \in s.audit : s.bytes[i] = s.saved[i]
RetiringInodePublished == \A i \in s.required : i # s.active => i \in s.audit /\ s.bytes[i] = s.saved[i]
PendingReachableAfterCrash == s.crashed /\ ~s.resolved => HasPending(s.bytes[s.active])
NoAppendToArchivedInode == ~s.badAppend
RefusalPreservesRetainedBytes == s.pc = "refused" => s.bytes = s.refusalBytes
TornNeverConsumed == ~s.consumed
WitnessAbsent == Goal \notin s.seen
=====================================================================
