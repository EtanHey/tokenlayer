----------------------------- MODULE Transfer -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Mutant, Known
VARIABLES alive, locked, capable, requested, observed, flying, pending,
          custody, quiet, release, ack, generation, accepted, badStop,
          admittedAck, admittedRelease, lateFinish, lostIntent
vars == <<alive, locked, capable, requested, observed, flying, pending,
          custody, quiet, release, ack, generation, accepted, badStop,
          admittedAck, admittedRelease, lateFinish, lostIntent>>
Init ==
    /\ alive = TRUE /\ locked = TRUE /\ capable = {"old"}
    /\ requested = FALSE /\ observed = FALSE /\ flying = {}
    /\ pending = FALSE /\ custody = "none" /\ quiet = FALSE
    /\ release = 0 /\ ack = 0 /\ generation = 1 /\ accepted = FALSE
    /\ admittedAck = 0 /\ admittedRelease = 0
    /\ badStop = FALSE /\ lateFinish = FALSE /\ lostIntent = FALSE
DispatchOld ==
    /\ alive /\ locked /\ "old" \in capable /\ ~pending
    /\ (~observed \/ Mutant = "stop")
    /\ flying' = flying \cup {"old"} /\ pending' = TRUE /\ custody' = "old"
    /\ badStop' = (badStop \/ observed)
    /\ UNCHANGED <<alive, locked, capable, requested, observed, quiet, release,
                   ack, generation, accepted, admittedAck, admittedRelease, lateFinish>>
Request ==
    /\ Known /\ ~requested /\ requested' = TRUE
    /\ UNCHANGED <<alive, locked, capable, observed, flying, pending, custody,
                   quiet, release, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Observe ==
    /\ alive /\ requested /\ ~observed /\ observed' = TRUE
    /\ UNCHANGED <<alive, locked, capable, requested, flying, pending, custody,
                   quiet, release, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Finish(success) ==
    /\ "old" \in flying /\ flying' = flying \ {"old"}
    /\ pending' = ~success /\ custody' = IF success THEN "none" ELSE "old"
    /\ lateFinish' = (lateFinish \/ observed)
    /\ UNCHANGED <<alive, locked, capable, requested, observed, quiet, release,
                   ack, generation, accepted, badStop, admittedAck, admittedRelease>>
Classify(hold) ==
    /\ Known /\ pending /\ "old" \notin flying /\ custody = "old"
    /\ pending' = hold /\ custody' = IF hold THEN "held" ELSE "none"
    /\ UNCHANGED <<alive, locked, capable, requested, observed, flying, quiet,
                   release, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Quiesce ==
    /\ Known /\ observed /\ ~quiet
    /\ ("old" \notin flying \/ Mutant = "drain")
    /\ (~pending \/ custody = "held" \/ Mutant = "drain")
    /\ quiet' = TRUE /\ locked' = FALSE
    /\ capable' = IF Mutant = "capability" THEN capable ELSE capable \ {"old"}
    /\ UNCHANGED <<alive, requested, observed, flying, pending, custody, release,
                   ack, generation, accepted, badStop, admittedAck, admittedRelease, lateFinish>>
Release ==
    /\ quiet /\ release # generation /\ release' = generation
    /\ UNCHANGED <<alive, locked, capable, requested, observed, flying, pending,
                   custody, quiet, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Ack ==
    /\ release = generation /\ ack # release /\ Mutant # "lost-message"
    /\ ack' = release
    /\ UNCHANGED <<alive, locked, capable, requested, observed, flying, pending,
                   custody, quiet, release, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
StaleAck ==
    /\ generation = 2 /\ ack = 0 /\ ack' = 1
    /\ UNCHANGED <<alive, locked, capable, requested, observed, flying, pending,
                   custody, quiet, release, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
StaleRelease ==
    /\ generation = 2 /\ release = 0 /\ release' = 1
    /\ UNCHANGED <<alive, locked, capable, requested, observed, flying, pending,
                   custody, quiet, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Accept ==
    /\ ~accepted
    /\ ((Known /\ quiet /\ release = generation /\ ack = generation)
         \/ (Mutant = "stale" /\ ack > 0))
    /\ accepted' = TRUE /\ capable' = capable \cup {"new"}
    /\ admittedAck' = ack /\ admittedRelease' = release
    /\ pending' = IF Mutant = "clear-both" THEN FALSE ELSE pending
    /\ custody' = IF Mutant = "clear-both" \/ (Mutant = "custody" /\ pending)
                   THEN "none" ELSE custody
    /\ UNCHANGED <<alive, locked, requested, observed, flying, quiet,
                   release, ack, generation, badStop, lateFinish>>
DispatchNew ==
    /\ accepted /\ flying' = flying \cup {"new"}
    /\ UNCHANGED <<alive, locked, capable, requested, observed, pending, custody,
                   quiet, release, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Crash ==
    /\ alive /\ ~quiet /\ alive' = FALSE
    /\ UNCHANGED <<locked, capable, requested, observed, flying, pending, custody,
                   quiet, release, ack, generation, accepted, badStop,
                   admittedAck, admittedRelease, lateFinish>>
Restart ==
    /\ Known /\ ~alive /\ ~quiet /\ generation = 1
    /\ alive' = TRUE /\ generation' = 2 /\ observed' = FALSE /\ requested' = FALSE
    /\ UNCHANGED <<locked, capable, flying, pending, custody, quiet, release, ack,
                   accepted, badStop, admittedAck, admittedRelease, lateFinish>>
CooperativeActions == DispatchOld \/ Request \/ Observe \/ Finish(TRUE)
               \/ Classify(FALSE) \/ Classify(TRUE) \/ Quiesce \/ Release \/ Ack
               \/ Accept \/ DispatchNew
TrackCustody == lostIntent' = (lostIntent \/
    (pending /\ ~accepted /\ accepted' /\ (~pending' \/ custody' # "held")))
Cooperative == CooperativeActions /\ TrackCustody
Next == (CooperativeActions \/ Finish(FALSE) \/ Crash \/ Restart \/ StaleAck \/ StaleRelease)
        /\ TrackCustody
Spec == Init /\ [][Next]_vars
FairSpec == Init /\ [][Cooperative]_vars
    /\ WF_vars(Request /\ TrackCustody) /\ WF_vars(Observe /\ TrackCustody)
    /\ WF_vars(Finish(TRUE) /\ TrackCustody) /\ WF_vars(Classify(FALSE) /\ TrackCustody)
    /\ WF_vars(Quiesce /\ TrackCustody) /\ WF_vars(Release /\ TrackCustody)
    /\ WF_vars(Ack /\ TrackCustody) /\ WF_vars(Accept /\ TrackCustody)
GlobalSingleDispatcher == Cardinality(flying) <= 1
NoPostStopDispatch == ~badStop
AdmissionQuiescent == accepted => "old" \notin capable
CustodyRetained == pending => custody \in IF accepted THEN {"held"} ELSE {"old", "held"}
NoIntentDiscard == ~lostIntent
FreshAcknowledgment == accepted => admittedAck = generation /\ admittedRelease = generation
HandoffProgress == <>accepted
WitnessStopped == ~observed
WitnessLateFinish == ~lateFinish
WitnessHeldTransfer == ~(accepted /\ pending /\ custody = "held")
WitnessRestart == ~(generation = 2 /\ alive)
WitnessStaleAck == ~(generation = 2 /\ ack = 1 /\ ~quiet)
WitnessStaleRelease == ~(generation = 2 /\ release = 1 /\ ~quiet)
WitnessDelayedAck == ~(release = generation /\ ack # generation)
WitnessUnknownHold == ~(~Known /\ ~alive /\ "old" \in flying /\ ~accepted)
WitnessAccepted == ~accepted
WitnessSuccessfulHeldHandoff == ~(accepted /\ "new" \in flying /\ "old" \notin flying
    /\ "old" \notin capable /\ pending /\ custody = "held"
    /\ ack = generation /\ release = generation)
=============================================================================
