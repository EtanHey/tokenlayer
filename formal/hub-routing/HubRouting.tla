--------------------------- MODULE HubRouting ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Target, Scenario, ReleaseEnabled
VARIABLE s
vars == <<s>>
A == {1,2}
K == {"Fable","Other"}
M == {"7d","7d_oi"}
Relevant(k) == IF k="Fable" THEN M ELSE {"7d"}
Allowed(a,k) == \A m \in Relevant(k): s.quota[a][m] # "rejected"
Fresh(a,k) == \A m \in Relevant(k): s.age[a][m]=0 /\ s.obs[a][m] # "unknown"
Believed(a,k) == Fresh(a,k) /\ ~s.cool[a][k] /\ ~s.disabled[a] /\
                 \A m \in Relevant(k): s.obs[a][m] # "rejected"
AllFresh == \A a \in A: Fresh(a,"Fable")
Soon == IF {a \in A: Believed(a,"Other")}={} THEN 0 ELSE
 CHOOSE a \in {x \in A: Believed(x,"Other")}:
  \A b \in A: Believed(b,"Other") =>
   (s.seenReset[a]["7d"] < s.seenReset[b]["7d"] \/
    (s.seenReset[a]["7d"]=s.seenReset[b]["7d"] /\ a<=b))
Desired(k) == IF k="Fable" /\ Believed(1,k) THEN 1 ELSE Soon
Candidates == {a \in A: ~s.disabled[a] /\ s.kind \notin s.excluded[a] /\
                        ~s.cool[a][s.kind] /\ a \notin s.tried}
Pick == IF s.binding[s.kind] \in Candidates /\ s.ttl[s.kind]>0
 THEN s.binding[s.kind]
 ELSE IF Candidates={} THEN 0 ELSE CHOOSE a \in Candidates:
  \A b \in Candidates: s.priority[a]>s.priority[b] \/
                       (s.priority[a]=s.priority[b] /\ a<=b)
DisplayCandidates == {a \in A: (IF Target THEN Fresh(a,"Other") ELSE TRUE) /\
  s.obs[a]["7d"] \notin {"rejected","unknown"}}
DisplayWinner == IF DisplayCandidates={} THEN 0 ELSE
 CHOOSE a \in DisplayCandidates: \A b \in DisplayCandidates:
  s.priority[a]>s.priority[b] \/ (s.priority[a]=s.priority[b] /\
   (s.seenReset[a]["7d"]<s.seenReset[b]["7d"] \/
    (s.seenReset[a]["7d"]=s.seenReset[b]["7d"] /\ a<=b)))
Init == \E k \in K, b \in {0,2}:
 s=[quota |-> [a \in A |-> [m \in M |-> "allowed_warning"]],
    reset |-> [a \in A |-> [m \in M |-> IF a=1 THEN 2 ELSE 1]],
    obs |-> [a \in A |-> [m \in M |-> "allowed_warning"]],
    seenReset |-> [a \in A |-> [m \in M |-> IF a=1 THEN 2 ELSE 1]],
    age |-> [a \in A |-> [m \in M |-> 0]],
    priority |-> [a \in A |-> 0], excluded |-> [a \in A |-> {}],
    disabled |-> [a \in A |-> FALSE], cool |-> [a \in A |-> [j \in K |-> FALSE]],
    binding |-> [j \in K |-> IF j=k THEN b ELSE 0],
    ttl |-> [j \in K |-> IF j=k /\ b#0 THEN 1 ELSE 0],
    kind |-> k, pc |-> IF Scenario="convergence" THEN "idle" ELSE "pending",
    flight |-> 0, tries |-> 0, tried |-> {}, mode |-> "OFF", spill |-> "off",
    confirmed |-> FALSE, fable |-> TRUE, steer |-> FALSE, owner |-> "old",
    patch |-> "idle", releasing |-> 0, changed |-> 0,
    external |-> FALSE, resetDone |-> FALSE, expired |-> FALSE,
    restarted |-> FALSE, reloaded |-> FALSE, manual |-> FALSE,
    nextRequest |-> FALSE, clock |-> 0,
    badFail |-> FALSE, badKnown |-> FALSE, badFable |-> FALSE, badSoon |-> FALSE,
    shownCurrent |-> [a \in A |-> [m \in M |-> FALSE]], shownAge |-> [a \in A |-> [m \in M |-> 0]],
    active |-> 0, badActive |-> FALSE, incident |-> FALSE,
    releaseFlight |-> FALSE, reloadFlight |-> FALSE, restartFlight |-> FALSE]
Handover == /\ Target /\ s.owner="old"
 /\ s'=[s EXCEPT !.fable=FALSE, !.steer=FALSE, !.owner="new"]
NewController == Target /\ s.owner="new"
Replan ==
 /\ NewController \/ (s.fable /\ s.mode#"AUTO")
 /\ LET healthy == (\A a \in A: Fresh(a,"Other"))
        top == Soon
        restrict == Believed(1,"Fable") \/
          (~Target /\ Fresh(1,"Fable") /\ s.obs[1]["7d_oi"]="rejected" /\
           (s.spill="off" \/ (s.spill="auto" /\ ~s.confirmed)))
    IN s'=[s EXCEPT
      !.priority=[a \in A |-> IF NewController THEN (IF a=top THEN 100 ELSE 50)
        ELSE IF ~healthy \/ s.mode="OFF" THEN 0
        ELSE IF a=2 THEN 100 ELSE 50],
      !.excluded=[a \in A |->
        IF NewController THEN (IF a=2 /\ Believed(1,"Fable") THEN {"Fable"} ELSE {}) \cup
          {k \in K: s.cool[a][k] \/ (Fresh(a,k) /\
            (\E m \in Relevant(k): s.obs[a][m]="rejected"))}
        ELSE IF ~healthy \/ s.mode="OFF" THEN {}
        ELSE IF a=2 /\ restrict THEN {"Fable"} ELSE {}]]
SteerStart == /\ ~Target /\ ~s.steer /\ ~s.manual
 /\ s'=[s EXCEPT !.steer=TRUE]
SteerWrite == /\ s.steer
 /\ s'=[s EXCEPT !.priority=[a \in A |-> IF a=Soon THEN 100 ELSE 50]]
ModeChange == /\ ~Target /\ s.changed<2
 /\ \E m \in {"OFF","ON","AUTO"}, p \in {"off","on","auto"}:
    s'=[s EXCEPT !.mode=m, !.spill=p, !.changed=@+1]
StopAndManual == /\ ~Target /\ ~s.manual
 /\ s'=[s EXCEPT !.fable=FALSE, !.steer=FALSE, !.manual=TRUE,
                  !.priority=[a \in A |-> IF a=1 THEN 100 ELSE 0]]
Dispatch == /\ s.pc="pending"
 /\ LET a == Pick
        rebound == s.binding[s.kind]=0 \/ s.ttl[s.kind]=0 \/ s.binding[s.kind]#a
    IN IF a=0 THEN s'=[s EXCEPT !.pc="rejected",
      !.badFail=@ \/ (\E b \in A: Allowed(b,s.kind))]
    ELSE s'=[s EXCEPT !.pc="inFlight", !.flight=a, !.tries=@+1,
      !.binding[s.kind]=a, !.ttl[s.kind]=1,
      !.badKnown=@ \/ (s.tries=0 /\ Fresh(a,s.kind) /\
                        \E m \in Relevant(s.kind): s.obs[a][m]="rejected"),
      !.badFable=@ \/ (rebound /\ s.kind="Fable" /\ AllFresh /\
                       s.obs[1]["7d"]#"rejected" /\ s.obs[1]["7d_oi"]#"rejected" /\ a#1),
      !.badSoon=@ \/ (rebound /\ (\A b \in A: Fresh(b,"Other")) /\ s.kind="Other" /\
        (s.obs[a]["7d"]="rejected" \/
         \E b \in A: s.obs[b]["7d"]#"rejected" /\ s.seenReset[b]["7d"]<s.seenReset[a]["7d"])),
      !.incident=@ \/ (~Target /\ s.kind="Other" /\ rebound /\ s.expired /\ s.binding[s.kind]#0 /\ s.ttl[s.kind]=0 /\
        s.priority[1]=s.priority[2] /\ Allowed(a,"Other") /\
        (\E b \in A: Allowed(b,"Other") /\ s.reset[b]["7d"]<s.reset[a]["7d"]) /\
        s.active#0 /\ s.active#a /\ s.shownCurrent[s.active]["7d"] /\
        s.age[s.active]["7d"]>0)]
Finish == /\ s.pc="inFlight"
 /\ LET a == s.flight IN s'=[s EXCEPT
    !.pc=IF Allowed(a,s.kind) THEN "served" ELSE IF s.tries=4 THEN "rejected" ELSE "pending",
    !.badFail=@ \/ (~Allowed(a,s.kind) /\ s.tries=4 /\ \E b \in A: Allowed(b,s.kind)),
    !.tried=IF Allowed(a,s.kind) THEN @ ELSE @ \cup {a},
    !.binding[s.kind]=IF Allowed(a,s.kind) THEN @ ELSE 0,
    !.cool[a][s.kind]=IF Allowed(a,s.kind) THEN @ ELSE TRUE,
    !.obs[a]=[m \in M |-> IF m \in Relevant(s.kind) THEN s.quota[a][m] ELSE s.obs[a][m]],
    !.seenReset[a]=[m \in M |-> IF m \in Relevant(s.kind) THEN s.reset[a][m] ELSE s.seenReset[a][m]],
    !.age[a]=[m \in M |-> IF m \in Relevant(s.kind) THEN 0 ELSE s.age[a][m]],
    !.quota[a]=[m \in M |-> IF Allowed(a,s.kind) /\ m \in Relevant(s.kind)
      THEN IF s.quota[a][m]="allowed" THEN "allowed_warning" ELSE "rejected"
      ELSE s.quota[a][m]]]
NextRequest == /\ s.pc \in {"served","rejected","killed"} /\ ~s.nextRequest
 /\ \E k \in K: s'=[s EXCEPT !.kind=k, !.pc="pending", !.tries=0,
                               !.tried={}, !.nextRequest=TRUE]
Age(a,m) == /\ s.age[a][m]=0 /\ s'=[s EXCEPT !.age[a][m]=1]
ResetClock == /\ s.clock<2 /\ s'=[s EXCEPT !.clock=@+1]
Reset(a,m) == /\ ~s.resetDone /\ s.reset[a][m]<=s.clock
 /\ s'=[s EXCEPT !.resetDone=TRUE, !.quota[a][m]="allowed", !.reset[a][m]=3]
Expire == /\ ~s.expired /\ (\E k \in K: s.ttl[k]>0)
 /\ s'=[s EXCEPT !.expired=TRUE, !.ttl=[k \in K |-> 0]]
ExternalUse(a,m) == /\ ~s.external /\ s.quota[a][m]#"rejected"
 /\ s'=[s EXCEPT !.external=TRUE, !.quota[a][m]="rejected"]
CooldownEnds(a,k) == /\ s.cool[a][k] /\ s'=[s EXCEPT !.cool[a][k]=FALSE]
Publish == s'=[s EXCEPT
 !.shownAge=s.age,
 !.shownCurrent=[a \in A |-> [m \in M |->
   IF Target THEN s.age[a][m]=0 /\ s.obs[a][m]#"unknown" ELSE TRUE]],
 !.active=DisplayWinner,
 !.badActive=@ \/ (DisplayWinner#0 /\ ~Fresh(DisplayWinner,"Other") /\
                   \A k \in K: s.binding[k]#DisplayWinner)]
ReleaseDisable(a,ok) == /\ Target /\ ReleaseEnabled /\ s.owner="new" /\ s.patch="idle"
 /\ a \in A /\ (\E k \in K: s.binding[k]=a /\ Desired(k)#a)
 /\ s'=[s EXCEPT !.patch=IF ok THEN "enable" ELSE "disableFailed", !.releasing=a,
   !.disabled[a]=IF ok THEN TRUE ELSE @,
   !.binding=[k \in K |-> IF ok /\ s.binding[k]=a THEN 0 ELSE s.binding[k]],
   !.releaseFlight=(ok /\ s.pc="inFlight" /\ s.flight=a)]
ReleaseEnable(ok) == /\ s.patch="enable"
 /\ s'=[s EXCEPT !.patch=IF ok THEN "done" ELSE "enableFailed",
                   !.disabled[s.releasing]=IF ok THEN FALSE ELSE @]
ConfigReload == /\ ~s.reloaded
 /\ s'=[s EXCEPT !.reloaded=TRUE, !.binding=[k \in K |-> 0],
                  !.reloadFlight=(s.pc="inFlight")]
Restart == /\ ~s.restarted
 /\ s'=[s EXCEPT !.restarted=TRUE, !.binding=[k \in K |-> 0],
   !.pc=IF s.pc="inFlight" THEN "killed" ELSE @,
   !.obs=[a \in A |-> [m \in M |-> "unknown"]],
   !.age=[a \in A |-> [m \in M |-> 1]], !.restartFlight=(s.pc="inFlight")]
Environment == (\E a \in A,m \in M: Age(a,m)) \/ ResetClock \/
 (\E a \in A,m \in M: Reset(a,m) \/ ExternalUse(a,m)) \/ Expire \/
 (\E a \in A,k \in K: CooldownEnds(a,k))
Release == (\E a \in A,ok \in (IF Scenario="convergence-reliable" THEN {TRUE} ELSE BOOLEAN): ReleaseDisable(a,ok)) \/
           (\E ok \in (IF Scenario="convergence-reliable" THEN {TRUE} ELSE BOOLEAN): ReleaseEnable(ok))
Next == SteerStart \/ Dispatch \/ Finish \/ Publish \/ Handover \/ Replan \/
 IF Scenario \in {"convergence","convergence-reliable"} THEN Release
 ELSE IF Scenario="handover" THEN SteerWrite
 ELSE IF Scenario \in {"release","release-no-restart"} THEN Release \/ ConfigReload \/
   (IF Scenario="release" THEN Restart ELSE FALSE)
 ELSE IF Scenario="restart" THEN Restart
 ELSE IF Scenario="known" THEN NextRequest \/
   (\E a \in A,m \in M: ExternalUse(a,m)) \/
   (\E a \in A,k \in K: CooldownEnds(a,k))
 ELSE IF Scenario="progress" THEN Release \/ ConfigReload \/ Restart \/
   (\E a \in A,m \in M: ExternalUse(a,m))
 ELSE IF Scenario="telemetry" THEN (\E a \in A,m \in M: Age(a,m))
 ELSE Release \/ Environment \/ NextRequest \/ ModeChange \/ StopAndManual \/ SteerWrite \/ Restart
Spec == Init /\ [][Next]_vars /\ WF_vars(Dispatch) /\ WF_vars(Finish) /\
        WF_vars(Handover) /\ WF_vars(Replan) /\ WF_vars(Release)
NoFailWhileOtherAllowed == ~s.badFail
NoKnownRejectedFirstTry == ~s.badKnown
FablePreference == ~s.badFable
SoonestResetFirst == ~s.badSoon
RenderedCurrent(a,m) == s.shownCurrent[a][m] /\
                       (IF Target THEN s.age[a][m]=0 ELSE TRUE)
RenderedActive(a) == s.active=a /\ (IF Target THEN Fresh(a,"Other") ELSE TRUE)
NoStaleAsCurrent == \A a \in A,m \in M: s.age[a][m]>0 => ~RenderedCurrent(a,m)
NoFalseActive == ~s.badActive /\ (\A a \in A: RenderedActive(a) =>
 Fresh(a,"Other") \/ (\E k \in K: s.binding[k]=a))
SingleWriter == (IF s.fable THEN 1 ELSE 0) + (IF s.steer THEN 1 ELSE 0) +
                (IF s.owner="new" THEN 1 ELSE 0) <= 1
NoStrand == ((s.pc \in {"pending","inFlight"}) ~> (s.pc \in {"served","rejected"})) /\ []NoFailWhileOtherAllowed
ConvergesWhenFresh == (<>[]AllFresh) =>
 \A k \in K: (AllFresh /\ s.binding[k]#0 /\ s.binding[k]#Desired(k)) ~>
                  (s.binding[k]=0 \/ s.binding[k]=Desired(k))
WitnessIncident == ~s.incident
WitnessReleaseInFlight == ~s.releaseFlight
WitnessReleaseCompleted == ~(s.releaseFlight /\ s.pc="served")
WitnessReloadInFlight == ~s.reloadFlight
WitnessRestartInFlight == ~s.restartFlight
WitnessEnableFailure == s.patch#"enableFailed"
WitnessDisableFailure == s.patch#"disableFailed"
WitnessCapFailure == ~(s.badFail /\ s.mode="ON" /\ s.obs[1]["7d_oi"]="rejected" /\
                        "Fable" \in s.excluded[2])
WitnessAutoRetains == ~(s.mode="AUTO" /\ "Fable" \in s.excluded[2])
WitnessStoppedExclusions == ~(s.manual /\ "Fable" \in s.excluded[2])
WitnessResetBound == ~(s.resetDone /\ \E k \in K: s.binding[k]#0 /\ s.ttl[k]>0)
=============================================================================
