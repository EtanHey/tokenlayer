----------------------------- MODULE Importer -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Mutation, Faults, Goal, RecheckStop
VARIABLES s, partialStopBad, partialCustodyBad
vars == <<s, partialStopBad, partialCustodyBad>>
Keys == 1..2
Max(a, b) == IF a > b THEN a ELSE b
Pending == s.ledger.status \in {"intent", "ambiguous"}
Full == s.ledger.keys \subseteq s.stored
Partial == s.ledger.keys \cap s.stored # {} /\ ~Full
Init == /\ s = [pc |-> "idle", cp |-> 0, wa |-> 0, acknowledged |-> 0,
             batch |-> {}, hi |-> 0, stored |-> {}, wire |-> {},
             ledger |-> [status |-> "none", keys |-> {}, end |-> 0],
             stop |-> FALSE, accepted |-> FALSE, crashes |-> 0,
             recoveryBad |-> FALSE, stopBad |-> FALSE,
             event |-> "init"]
        /\ partialStopBad = FALSE /\ partialCustodyBad = FALSE
Prepare(end) ==
    /\ s.pc = "idle" /\ ~s.stop /\ s.cp < 2
    /\ s' = [s EXCEPT !.hi = end, !.batch = (s.cp + 1)..end,
                     !.wa = end, !.pc = "prepared", !.event = "write-ahead"]
Intent ==
    /\ s.pc \in {"prepared", "guard-wait"}
    /\ (~s.stop \/ Mutation = "ignore-stop" \/ (s.pc = "guard-wait" /\ ~RecheckStop))
    /\ s' = [s EXCEPT !.ledger = [status |-> "intent", keys |-> s.batch, end |-> s.hi],
                     !.pc = "intent", !.event = "intent"]
Send ==
    /\ (s.pc = "intent" \/ (s.pc = "prepared" /\ Mutation = "no-intent"))
    /\ ~(s.batch \subseteq s.stored)
    /\ s' = [s EXCEPT !.wire = @ \cup {s.batch}, !.pc = "sent",
                     !.stopBad = @ \/ s.stop, !.event = "dispatch"]
Covered ==
    /\ s.pc = "intent" /\ s.batch \subseteq s.stored
    /\ s' = [s EXCEPT !.pc = "reply", !.event = "covered-skip"]
Apply ==
    \E batch \in s.wire: \E applied \in SUBSET batch:
        /\ (Faults \/ applied = batch)
        /\ s' = [s EXCEPT !.stored = @ \cup applied, !.wire = @ \ {batch},
                         !.event = IF s.pc = "sent" /\ s.stored \cap batch # {}
                                   /\ ~(batch \subseteq s.stored)
                                   THEN "fresh-overlap" ELSE "apply"]
Reply ==
    /\ s.pc = "sent" /\ s.batch \notin s.wire /\ s.batch \subseteq s.stored
    /\ s' = [s EXCEPT !.pc = "reply", !.event = "response"]
Ack ==
    /\ s.pc = "reply"
    /\ s' = [s EXCEPT !.ledger.status = "acked",
                     !.acknowledged = Max(@, s.hi), !.pc = "acked", !.event = "ack"]
Checkpoint ==
    /\ s.pc = "acked" /\ Mutation # "stall"
    /\ s' = [s EXCEPT !.cp = s.hi, !.pc = "idle", !.event = "checkpoint"]
EarlyCheckpoint ==
    /\ Mutation = "early-checkpoint" /\ s.pc = "sent"
    /\ s' = [s EXCEPT !.cp = s.hi, !.event = "early-checkpoint"]
Failure ==
    /\ Faults /\ s.pc \in {"sent", "reply"}
    /\ s' = [s EXCEPT !.ledger.status = "ambiguous", !.pc = "down",
                     !.batch = {}, !.event = "ambiguous"]
Crash ==
    /\ Faults /\ s.crashes < 1 /\ s.pc \in {"prepared", "guard-wait", "intent", "sent", "reply", "acked"}
    /\ s' = [s EXCEPT !.pc = "down", !.batch = {}, !.crashes = @ + 1,
                     !.event = "crash"]
Restart ==
    /\ s.pc = "down"
    /\ s' = [s EXCEPT !.pc = "recover", !.stop = FALSE, !.event = "restart"]
Reconcile ==
    /\ s.pc = "recover" /\ Pending
    /\ LET terminal == IF Full \/ (Partial /\ Mutation = "partial-ack")
                       THEN "acked" ELSE IF Partial THEN s.ledger.status ELSE "retry"
           nextCP == IF Full /\ Mutation = "recovery-commit" THEN s.ledger.end ELSE s.cp
       IN s' = [s EXCEPT !.ledger.status = terminal, !.cp = nextCP,
                         !.acknowledged = IF terminal = "acked" THEN Max(@, s.ledger.end) ELSE @,
                         !.recoveryBad = @ \/ (nextCP # s.cp),
                         !.pc = IF Mutation = "partial-continue" THEN "reset"
                                ELSE IF Partial /\ terminal # "acked" THEN "halt" ELSE "reset",
                         !.event = IF Partial THEN "partial-stop"
                                   ELSE IF Full THEN "full-reconcile" ELSE "zero-reconcile"]
NoPending ==
    /\ s.pc = "recover" /\ ~Pending
    /\ s' = [s EXCEPT !.pc = "reset", !.event = "no-pending"]
Reset ==
    /\ s.pc = "reset"
    /\ s' = [s EXCEPT !.wa = s.cp, !.hi = s.cp, !.pc = "idle", !.event = "reset"]
RequestStop ==
    \* Intent -> Send is synchronous; guard-wait restores stream.ts:172's await.
    /\ Faults /\ ~s.stop /\ s.pc \notin {"intent", "down", "done", "halt"}
    /\ s' = [s EXCEPT !.stop = TRUE, !.event = "stop"]
Stop ==
    /\ s.stop /\ (s.pc \in {"idle", "prepared"} \/ (RecheckStop /\ s.pc = "guard-wait"))
    /\ s' = [s EXCEPT !.pc = "halt", !.event = "stop-refusal"]
LoseKey ==
    /\ Faults /\ s.pc = "idle" /\ s.cp = 2 /\ s.stored # {}
    /\ \E key \in s.stored:
        s' = [s EXCEPT !.stored = @ \ {key}, !.event = "external-loss"]
Accept ==
    /\ s.pc = "idle" /\ s.cp = 2 /\ ~s.stop
    /\ (s.stored = Keys \/ Mutation = "accept-mismatch")
    /\ s' = [s EXCEPT !.accepted = TRUE, !.pc = "done", !.event = "accept"]
RefuseFinal ==
    /\ s.pc = "idle" /\ s.cp = 2 /\ ~s.stop /\ s.stored # Keys
    /\ s' = [s EXCEPT !.pc = "halt", !.event = "final-refusal"]
\* Terminal history after batch {1} makes the conditional await reachable.
\* Branch selection is nondeterministic; capacity/rotation internals are excluded.
GuardThenAwait ==
    /\ s.pc = "prepared" /\ ~s.stop /\ s.cp = 1 /\ s.ledger.status = "acked"
    /\ s' = [s EXCEPT !.pc = "guard-wait", !.event = "await-reconcile-after-stop-check"]
Work == GuardThenAwait \/ (\E end \in (s.cp + 1)..2: Prepare(end)) \/ Intent \/ Send \/ Covered
        \/ Reply \/ Ack \/ Checkpoint \/ EarlyCheckpoint \/ Restart \/ Reconcile
        \/ NoPending \/ Reset \/ Stop \/ Accept \/ RefuseFinal
\* Inspect Reconcile's actual post-state, independently of its event label.
PartialRecoveryStep == s.pc = "recover" /\ Pending /\ Partial /\ Reconcile
Monitors == /\ partialStopBad' = (partialStopBad \/ (PartialRecoveryStep /\ s'.pc # "halt"))
            /\ partialCustodyBad' = (partialCustodyBad \/ (PartialRecoveryStep /\ s'.ledger # s.ledger))
Next == (Work \/ Apply \/ Crash \/ Failure \/ RequestStop \/ LoseKey) /\ Monitors
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Work /\ Monitors) /\ WF_vars(Apply /\ Monitors)
IntentBeforeDispatch == s.pc = "sent" =>
    (s.ledger.status = "intent" /\ s.ledger.keys = s.batch)
CheckpointAfterAck == s.cp <= s.acknowledged
PartialPendingStops == ~partialStopBad
PartialPendingCustody == ~partialCustodyBad
RecoveryDoesNotCheckpoint == ~s.recoveryBad
StopBeforeDispatch == ~s.stopBad
AcceptanceRequiresFinal == s.accepted => (s.cp = 2 /\ s.stored = Keys)
EventuallyAccepted == <>s.accepted
WitnessAbsent == IF Goal = "partial-effects" THEN ~(s.pc = "halt" /\ Pending /\ Partial)
                 ELSE IF Goal = "terminal-await-stop"
                      THEN ~(s.pc = "guard-wait" /\ s.stop /\ s.cp = 1 /\ s.ledger.status = "acked")
                 ELSE s.event # Goal
=============================================================================
