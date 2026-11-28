--------------------------- MODULE HubRouting ---------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Target
VARIABLE s
vars == <<s>>
Accounts == {1, 2}
Meters == {"7d", "7d_oi"}
Relevant(k) == IF k = "Fable" THEN Meters ELSE {"7d"}
Allowed(a, k) == \A m \in Relevant(k): s.quota[a][m] # "rejected"
Eligible == {a \in Accounts: Allowed(a, s.kind)}
Earliest(k) == IF {a \in Accounts: Allowed(a,k)} = {} THEN 0 ELSE CHOOSE a \in {x \in Accounts: Allowed(x,k)}:
  \A b \in Accounts: Allowed(b,k) =>
    (s.reset[a]["7d"] < s.reset[b]["7d"] \/
     (s.reset[a]["7d"] = s.reset[b]["7d"] /\ a <= b))
Preferred == IF s.kind = "Fable" /\ Allowed(1,"Fable") THEN 1
             ELSE IF Eligible # {} THEN Earliest(s.kind) ELSE 0
Catalog == IF s.running /\ s.mode="ON" /\ s.kind="Fable" /\ Allowed(1,"Fable")
           THEN {1} ELSE Accounts
CurrentPick == IF s.bindings[s.kind] # 0 /\ s.ttls[s.kind] > 0 /\ s.bindings[s.kind] \in Catalog \ s.tried
               THEN s.bindings[s.kind]
               ELSE IF Catalog \ s.tried = {} THEN 0
               ELSE CHOOSE a \in Catalog \ s.tried:
                 \A b \in Catalog \ s.tried:
                   s.priority[a] > s.priority[b] \/
                   (s.priority[a] = s.priority[b] /\ a <= b)
Pick == IF Target THEN
          IF s.bindings[s.kind] # 0 /\ s.ttls[s.kind] > 0 /\ Allowed(s.bindings[s.kind],s.kind)
          THEN s.bindings[s.kind] ELSE Preferred
        ELSE CurrentPick
AtCap == s.quota[1]["7d_oi"] = "rejected"
Wait == ~Target /\ s.running /\ s.mode = "ON" /\ AtCap /\
        (s.spill = "off" \/ (s.spill = "auto" /\ ~s.confirmed)) /\ s.kind = "Fable"
Advance(q) == IF q = "allowed" THEN "allowed_warning" ELSE "rejected"
Init == \E mode \in {"OFF","ON","AUTO"}, spill \in {"off","on","auto"}, b \in {0,1,2}:
 (Target => (mode="OFF" /\ spill="on")) /\
 s = [quota |-> [a \in Accounts |-> [m \in Meters |-> "allowed_warning"]],
       reset |-> [a \in Accounts |-> [m \in Meters |-> IF m = "7d" THEN a ELSE 3-a]],
       now |-> 0, bindings |-> [k \in {"Fable","Other"} |-> IF k="Fable" THEN b ELSE 0],
       ttls |-> [k \in {"Fable","Other"} |-> IF k="Fable" /\ b#0 THEN 1 ELSE 0], flight |-> 0, restarted |-> FALSE, releaseFlight |-> FALSE, restartFlight |-> FALSE,
       kind |-> "Fable", pc |-> "pending", tried |-> {}, retries |-> 0,
       mode |-> mode, spill |-> spill, confirmed |-> FALSE,
       running |-> TRUE, steer |-> FALSE, manual |-> FALSE,
       priority |-> [a \in Accounts |-> 0], writers |-> {"fable"},
       observation |-> [a \in Accounts |-> [m \in Meters |-> "allowed_warning"]],
       age |-> 0, current |-> TRUE, active |-> 1,
       usedExternal |-> FALSE, usedReset |-> FALSE, changedMode |-> FALSE,
       released |-> FALSE, nextRequest |-> FALSE,
       badRejected |-> FALSE, badFable |-> FALSE, badSoon |-> FALSE,
       badTerminal |-> FALSE]
Attempt ==
 /\ s.pc = "pending" /\ ~Wait
 /\ LET a == Pick
        fresh == s.bindings[s.kind] = 0 \/ s.ttls[s.kind] = 0 \/ a # s.bindings[s.kind]
    IN IF a = 0 THEN
       s' = [s EXCEPT !.pc = "rejected", !.badTerminal = Eligible # {}]
    ELSE
       s' = [s EXCEPT !.pc="inFlight", !.flight=a,
         !.badRejected = @ \/ (~Allowed(a,s.kind) /\ Eligible # {}),
         !.badFable = @ \/ (fresh /\ s.kind="Fable" /\ Allowed(1,"Fable") /\ a#1),
         !.badSoon = @ \/ (fresh /\ ~(s.kind="Fable" /\ Allowed(1,"Fable")) /\
                            Eligible # {} /\ a # Earliest(s.kind)),
         !.bindings[s.kind]=a, !.ttls[s.kind]=1]
Finish ==
 /\ s.pc="inFlight"
 /\ LET a == s.flight IN
    s' = [s EXCEPT
         !.pc = IF Allowed(a,s.kind) THEN "served"
                ELSE IF s.retries=3 THEN "rejected" ELSE "pending",
         !.badTerminal = @ \/ (~Allowed(a,s.kind) /\ s.retries=3 /\ Eligible # {}),
         !.bindings[s.kind]=IF Allowed(a,s.kind) THEN @ ELSE 0,
         !.ttls[s.kind]=IF Allowed(a,s.kind) THEN @ ELSE 0,
         !.tried = IF Allowed(a,s.kind) THEN @ ELSE @ \cup {a},
         !.retries = IF Allowed(a,s.kind) THEN @ ELSE @+1,
         !.quota[a] = IF Allowed(a,s.kind)
           THEN [m \in Meters |-> IF m \in Relevant(s.kind) THEN Advance(s.quota[a][m]) ELSE s.quota[a][m]]
           ELSE @]
NextRequest == /\ s.pc \in {"served","rejected"} /\ ~s.nextRequest
 /\ \E k \in {"Fable","Other"}: s' = [s EXCEPT !.pc="pending", !.kind=k,
      !.nextRequest=TRUE, !.tried={}, !.retries=0]
Tick == /\ s.now < 2
 /\ s' = [s EXCEPT !.now=@+1, !.ttls=[k \in {"Fable","Other"} |-> 0], !.age=@+1,
                   !.current=IF Target THEN FALSE ELSE @]
ExternalUse == /\ ~s.usedExternal
 /\ \E a \in Accounts, m \in Meters:
       s'=[s EXCEPT !.usedExternal=TRUE, !.quota[a][m]=Advance(@)]
Reset == /\ ~s.usedReset
 /\ \E a \in Accounts, m \in Meters:
     /\ s.reset[a][m] <= s.now
     /\ s'=[s EXCEPT !.usedReset=TRUE, !.quota[a][m]="allowed", !.reset[a][m]=3]
Observe == /\ s.age > 0
 /\ s'=[s EXCEPT !.observation=s.quota, !.age=0, !.current=TRUE,
                       !.active=IF Target THEN Preferred ELSE 1]
Replan == /\ s.running
 /\ s.mode # "AUTO"
 /\ s'=[s EXCEPT !.priority=[a \in Accounts |->
       IF Target THEN (IF a=Preferred THEN 100 ELSE 50)
       ELSE IF s.mode="OFF" THEN 0 ELSE IF a=1 THEN 50 ELSE 100]]
SteerStart == /\ ~Target /\ ~s.steer /\ ~s.manual
 /\ s'=[s EXCEPT !.steer=TRUE, !.writers=@ \cup {"steer"}]
SteerWrite == /\ s.steer
 /\ s'=[s EXCEPT !.priority=[a \in Accounts |-> IF a=Earliest("Other") THEN 100 ELSE 50]]
ModeChange == /\ ~Target /\ ~s.changedMode
 /\ \E m \in {"OFF","ON","AUTO"}, p \in {"off","on","auto"}:
     s'=[s EXCEPT !.mode=m, !.spill=p, !.changedMode=TRUE, !.confirmed=TRUE]
ManualOverride == /\ ~Target /\ ~s.manual
 /\ s'=[s EXCEPT !.manual=TRUE, !.running=FALSE, !.steer=FALSE,
                  !.writers={"manual"}, !.priority=[a \in Accounts |-> IF a=1 THEN 100 ELSE 0]]
ReleaseBindings(acct) ==
 /\ Target /\ ~s.released /\ acct \in Accounts
 /\ \E k \in {"Fable","Other"}: s.bindings[k]=acct
 /\ acct # Preferred
 /\ s'=[s EXCEPT !.bindings=[k \in {"Fable","Other"} |->
           IF s.bindings[k]=acct THEN 0 ELSE s.bindings[k]], !.released=TRUE, !.releaseFlight=(s.pc="inFlight" /\ s.flight=acct)]
Restart == /\ ~s.restarted
 /\ s'=[s EXCEPT !.bindings=[k \in {"Fable","Other"} |-> 0], !.restarted=TRUE, !.restartFlight=(s.pc="inFlight")]
Next == Finish \/ Restart \/ Attempt \/ NextRequest \/ Tick \/ ExternalUse \/ Reset \/ Observe \/ Replan
     \/ SteerStart \/ SteerWrite \/ ModeChange \/ ManualOverride \/ (\E a \in Accounts: ReleaseBindings(a))
Spec == Init /\ [][Next]_vars /\ WF_vars(Attempt) /\ WF_vars(Finish) /\ WF_vars(\E a \in Accounts: ReleaseBindings(a))
NoRejectedWhileOtherAllowed == ~s.badRejected
NoStrand == []((s.pc \in {"pending","inFlight"}) ~> (s.pc \in {"served","rejected"})) /\ [](~s.badTerminal)
NoStaleAsCurrent == s.age > 0 => ~s.current
FablePreference == ~s.badFable
SoonestResetFirst == ~s.badSoon
SingleWriter == Cardinality(s.writers) <= 1
WitnessReleaseInFlight == ~s.releaseFlight
WitnessRestartInFlight == ~s.restartFlight
WitnessRetry == s.retries=0
=============================================================================
