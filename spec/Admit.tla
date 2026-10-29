----------------------------- MODULE Admit -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS greenCap, brake60Cap, brake80Cap
VARIABLES accounts, fresh, paced, pending, leads, ordinary, workers
vars == <<accounts, fresh, paced, pending, leads, ordinary, workers>>
Accounts == {1, 2}
Dispatchers == {1, 2}
Readings == {"zero", "warm", "brake60", "brake80", "exhausted", "unknown", "rejected", "rolled"}
(* Raw observations for the independent safety oracle. Never call Usage/Headroom here. *)
Raw(a) == [status |-> IF accounts[a] = "rejected" THEN "rejected"
                     ELSE IF accounts[a] = "unknown" THEN "unknown" ELSE "allowed",
           used_pct |-> CASE accounts[a] \in {"zero", "rolled"} -> 0
                        [] accounts[a] = "warm" -> 59
                        [] accounts[a] = "brake60" -> 60
                        [] accounts[a] = "brake80" -> 80
                        [] OTHER -> 100,
           rolled_over |-> accounts[a] = "rolled"]
Usage(a) == CASE accounts[a] \in {"zero", "rolled"} -> 0
                 [] accounts[a] = "warm" -> 59
                 [] accounts[a] = "brake60" -> 60
                 [] accounts[a] = "brake80" -> 80
                 [] OTHER -> 100
Headroom == {a \in Accounts : Usage(a) \in {0, 59, 60, 80}}
Hot(n) == \E a \in Headroom : Usage(a) >= n
Pacing == \E a \in Headroom : paced[a] /\ Usage(a) > 0
Cap == IF Hot(80) THEN brake80Cap ELSE IF Hot(60) THEN brake60Cap ELSE greenCap
Init == /\ accounts \in [Accounts -> Readings]
        /\ fresh \in BOOLEAN
        /\ paced \in [Accounts -> BOOLEAN]
        /\ pending = [d \in Dispatchers |-> "idle"]
        /\ leads = 0 /\ ordinary = 0 /\ workers = 0
Request(d, kind) ==
  /\ pending[d] = "idle"
  /\ pending' = [pending EXCEPT ![d] = kind]
  /\ UNCHANGED <<accounts, fresh, paced, leads, ordinary, workers>>
(* Both dispatchers can queue before either commits. Recheck and reserve atomically. *)
Admit(d) ==
  /\ pending[d] # "idle" /\ fresh /\ Headroom # {}
  /\ IF pending[d] = "worker"
        THEN /\ ~Hot(60) /\ ~Pacing /\ workers = 0
             /\ workers' = workers + 1
             /\ UNCHANGED <<leads, ordinary>>
        ELSE /\ leads < Cap /\ (~Hot(80) \/ pending[d] = "essential")
             /\ leads' = leads + 1
             /\ ordinary' = ordinary + (IF pending[d] = "lead" THEN 1 ELSE 0)
             /\ UNCHANGED workers
  /\ pending' = [pending EXCEPT ![d] = "idle"]
  /\ UNCHANGED <<accounts, fresh, paced>>
FinishLead(essential) ==
  /\ IF essential THEN leads > ordinary ELSE ordinary > 0
  /\ leads' = leads - 1
  /\ ordinary' = ordinary - (IF essential THEN 0 ELSE 1)
  /\ UNCHANGED <<accounts, fresh, paced, pending, workers>>
FinishWorker == /\ workers > 0 /\ workers' = workers - 1
                /\ UNCHANGED <<accounts, fresh, paced, pending, leads, ordinary>>
Next == \/ \E d \in Dispatchers :
             (\E k \in {"lead", "essential", "worker"} : Request(d,k)) \/ Admit(d)
        \/ \E e \in BOOLEAN : FinishLead(e)
        \/ FinishWorker
Spec == Init /\ [][Next]_vars
TypeOK == /\ leads \in Nat /\ ordinary \in 0..leads /\ workers \in 0..1
          /\ pending \in [Dispatchers -> {"idle", "lead", "essential", "worker"}]
HeadroomOnly == (~fresh \/ Headroom = {}) => leads + workers = 0
NoBlindAdmit ==
  (~fresh \/ ~\E a \in Accounts :
    Raw(a).status = "allowed" /\
    (Raw(a).rolled_over \/ Raw(a).used_pct < 100)) => leads + workers = 0
CanonLeads == leads <= greenCap
Lead60 == Hot(60) => leads <= brake60Cap
Lead80 == Hot(80) => leads <= brake80Cap /\ ordinary = 0
WorkerBrake == (Hot(60) \/ Pacing) => workers = 0
=============================================================================
