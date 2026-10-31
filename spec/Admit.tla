----------------------------- MODULE Admit -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS greenCap, slowCap, stopCap
VARIABLES accounts, fresh, paced, pending, leads, ordinary, workers
vars == <<accounts, fresh, paced, pending, leads, ordinary, workers>>
Accounts == {1, 2}
Dispatchers == {1, 2}
Readings == {"zero", "warm", "slow", "stop", "exhausted", "unknown", "rejected", "rolled"}
(* Raw observations for the independent safety oracle. Never call Usage/Headroom here. *)
Raw(a) == [status |-> IF accounts[a] = "rejected" THEN "rejected"
                     ELSE IF accounts[a] = "unknown" THEN "unknown" ELSE "allowed",
           used_pct |-> CASE accounts[a] \in {"zero", "rolled"} -> 0
                        [] accounts[a] = "warm" -> 70
                        [] accounts[a] = "slow" -> 50
                        [] accounts[a] = "stop" -> 95
                        [] OTHER -> 100,
           rolled_over |-> accounts[a] = "rolled"]
Usage(a) == CASE accounts[a] \in {"zero", "rolled"} -> 0
                 [] accounts[a] = "warm" -> 70
                 [] accounts[a] = "slow" -> 50
                 [] accounts[a] = "stop" -> 95
                 [] OTHER -> 100
Headroom == {a \in Accounts : Usage(a) \in {0, 50, 70, 95}}
(* A reading abstracts an account's tightest present window. Best account wins. *)
Level(a) == IF Usage(a) >= 95 THEN "stop"
            ELSE IF accounts[a] = "slow" \/ (paced[a] /\ Usage(a) > 0) THEN "slow" ELSE "green"
Best == IF \E a \in Headroom : Level(a) = "green" THEN "green"
        ELSE IF \E a \in Headroom : Level(a) = "slow" THEN "slow" ELSE "stop"
Cap == IF Best = "stop" THEN stopCap ELSE IF Best = "slow" THEN slowCap ELSE greenCap
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
        THEN /\ Best = "green" /\ workers = 0
             /\ workers' = workers + 1
             /\ UNCHANGED <<leads, ordinary>>
        ELSE /\ leads < Cap /\ (Best # "stop" \/ pending[d] = "essential")
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
LeadSlow == Best = "slow" => leads <= slowCap
LeadStop == Best = "stop" => leads <= stopCap /\ ordinary = 0
WorkerBrake == Best # "green" => workers = 0
=============================================================================
