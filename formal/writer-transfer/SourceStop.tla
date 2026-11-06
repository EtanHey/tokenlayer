---------------------------- MODULE SourceStop ----------------------------
CONSTANT Mutant
VARIABLES requested, signalSeen, pollTrue, phase, terminalLedger,
          afterAwait, badSignal, badPoll
vars == <<requested, signalSeen, pollTrue, phase, terminalLedger,
          afterAwait, badSignal, badPoll>>
Init ==
    /\ requested = FALSE /\ signalSeen = FALSE /\ pollTrue = FALSE
    /\ phase = "ready" /\ terminalLedger = FALSE /\ afterAwait = "none"
    /\ badSignal = FALSE /\ badPoll = FALSE
Request ==
    /\ ~requested /\ requested' = TRUE
    /\ UNCHANGED <<signalSeen, pollTrue, phase, terminalLedger, afterAwait, badSignal, badPoll>>
Signal ==
    /\ requested /\ ~signalSeen /\ signalSeen' = TRUE
    /\ UNCHANGED <<requested, pollTrue, phase, terminalLedger, afterAwait, badSignal, badPoll>>
PollAndStart(wait) ==
    /\ phase = "ready" /\ (~wait \/ terminalLedger)
    /\ pollTrue' = signalSeen
    /\ phase' = IF signalSeen /\ Mutant # "poll" THEN "stopped"
                 ELSE IF wait THEN "waiting" ELSE "flying"
    /\ badSignal' = (badSignal \/ (signalSeen /\ phase' = "flying"))
    /\ badPoll' = (badPoll \/ (pollTrue' /\ phase' = "flying"))
    /\ UNCHANGED <<requested, signalSeen, terminalLedger, afterAwait>>
Resume ==
    /\ phase = "waiting"
    /\ afterAwait' = IF Mutant = "callback-guard" /\ signalSeen THEN "stopped" ELSE "flying"
    /\ pollTrue' = IF Mutant = "callback-guard" THEN signalSeen ELSE pollTrue
    /\ phase' = IF Mutant = "callback-guard" /\ signalSeen THEN "stopped" ELSE "flying"
    /\ badSignal' = (badSignal \/ (signalSeen /\ phase' = "flying"))
    /\ badPoll' = (badPoll \/ (pollTrue' /\ phase' = "flying"))
    /\ UNCHANGED <<requested, signalSeen, terminalLedger>>
Finish ==
    /\ phase = "flying" /\ phase' = "ready" /\ terminalLedger' = TRUE
    /\ UNCHANGED <<requested, signalSeen, pollTrue, afterAwait, badSignal, badPoll>>
Next == Request \/ Signal \/ (\E wait \in {TRUE, FALSE} : PollAndStart(wait)) \/ Resume \/ Finish
Spec == Init /\ [][Next]_vars
NoPostSignalDispatch == ~badSignal
NoPostPollDispatch == ~badPoll
WitnessAwaitGap == ~(afterAwait = "flying" /\ terminalLedger /\ signalSeen /\ ~pollTrue /\ badSignal)
WitnessProposalStop == ~(afterAwait = "stopped" /\ terminalLedger /\ phase = "stopped" /\ pollTrue)
=============================================================================
