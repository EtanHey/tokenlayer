----------------------------- MODULE Admit -----------------------------
EXTENDS Naturals
VARIABLES capacity, healthy, used, paced, worker, active, essential
vars == <<capacity, healthy, used, paced, worker, active, essential>>
Init == /\ capacity \in SUBSET {1, 2}
        /\ healthy \in BOOLEAN
        /\ used \in {0, 59, 60, 79, 80, 100}
        /\ paced \in BOOLEAN
        /\ worker \in BOOLEAN
        /\ active \in 0..10
        /\ essential \in BOOLEAN
Admitted == healthy /\ capacity # {} /\ used < 100 /\
  IF worker THEN used < 60 /\ ~paced
  ELSE IF used >= 80 THEN essential /\ active < 3
       ELSE IF used >= 60 THEN active < 5
            ELSE active < 10
Next == UNCHANGED vars
Spec == Init /\ [][Next]_vars
HeadroomOnly == Admitted => capacity # {}
HealthyOnly == Admitted => healthy
Worker80 == (worker /\ used >= 80) => ~Admitted
Lead60 == (Admitted /\ ~worker /\ used >= 60) => active + 1 <= 5
Lead80 == (Admitted /\ ~worker /\ used >= 80) => essential /\ active + 1 <= 3
WorkerPacing == (worker /\ paced) => ~Admitted
=============================================================================
