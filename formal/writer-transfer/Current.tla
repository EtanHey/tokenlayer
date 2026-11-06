----------------------------- MODULE Current -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Mutant
VARIABLES locks, flying
vars == <<locks, flying>>
Writers == {"M1a", "M1b", "M4"}
Parent(w) == IF w = "M4" THEN "M4-parent" ELSE "M1-parent"
Init == locks = {} /\ flying = {}
Acquire(w) ==
    /\ w \notin locks
    /\ (Mutant = "local" \/ ~\E x \in locks : Parent(x) = Parent(w))
    /\ locks' = locks \cup {w}
    /\ UNCHANGED flying
Dispatch(w) ==
    /\ w \in locks /\ w \notin flying
    /\ flying' = flying \cup {w}
    /\ UNCHANGED locks
Finish(w) == flying' = flying \ {w} /\ UNCHANGED locks
Cleanup(w) ==
    /\ w \notin flying /\ locks' = locks \ {w}
    /\ UNCHANGED flying
Next == \E w \in Writers : Acquire(w) \/ Dispatch(w) \/ Finish(w) \/ Cleanup(w)
Spec == Init /\ [][Next]_vars
LocalExclusive == \A p \in {"M1-parent", "M4-parent"} :
    Cardinality({w \in locks : Parent(w) = p}) <= 1
GlobalSingleDispatcher == Cardinality(flying) <= 1
WitnessLocal == ~("M1a" \in locks)
=============================================================================
