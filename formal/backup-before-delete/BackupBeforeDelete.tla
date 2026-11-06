-------------------------- MODULE BackupBeforeDelete --------------------------
EXTENDS Naturals, TLC
CONSTANTS InitialHold, AssumeRemoteDurability, Mutant, Witness
VARIABLES s, decision
vars == <<s, decision>>
Source(v) == [target |-> "A", version |-> v, hash |-> IF v=1 THEN "H1" ELSE "H2"]
Backup(v) == [id |-> "B", version |-> v, hash |-> IF v=1 THEN "BH1" ELSE "BH2"]
Manifest(v) == [id |-> "M", version |-> v, hash |-> IF v=1 THEN "MH1" ELSE "MH2"]
Init ==
 /\ s = [pc |-> "prepare", source |-> Source(1), backup |-> Backup(1),
         manifest |-> Manifest(1), coverage |-> "none", verify |-> "none", restored |-> FALSE,
         auth |-> "none", epoch |-> 1, hold |-> InitialHold, expired |-> FALSE,
         retained |-> 0, remoteAlive |-> TRUE, target |-> "A", receipt |-> [unused |-> TRUE]]
 /\ decision = [unused |-> TRUE]
Observe == /\ s.pc = "prepare"
 /\ \E c \in {"none","partial","full"}, v \in {"none","partial","unknown","failed","full"},
        r \in BOOLEAN : s' = [s EXCEPT !.pc="observed", !.coverage=c, !.verify=v, !.restored=r]
Seal == /\ s.pc = "observed"
 /\ s' = [s EXCEPT !.pc="sealed", !.retained=1,
     !.receipt=[source |-> s.source, backup |-> s.backup, manifest |-> s.manifest,
       coverage |-> s.coverage, verify |-> s.verify, restored |-> s.restored,
       epoch |-> s.epoch, id |-> 1]]
Authorize == /\ s.pc="sealed" /\ s.auth="none"
 /\ s'=[s EXCEPT !.auth="granted"]
Disturb == /\ s.pc="sealed"
 /\ \/ /\ s.source=Source(1) /\ s'=[s EXCEPT !.source=Source(2)]
    \/ /\ s.backup=Backup(1) /\ s'=[s EXCEPT !.backup=Backup(2)]
    \/ /\ s.manifest=Manifest(1) /\ s'=[s EXCEPT !.manifest=Manifest(2)]
    \/ /\ ~s.expired /\ s'=[s EXCEPT !.expired=TRUE]
    \/ /\ s.retained=1 /\ s'=[s EXCEPT !.retained=2]
    \/ /\ s.auth="granted" /\ s'=[s EXCEPT !.auth="revoked", !.epoch=2]
    \/ /\ ~s.hold /\ s'=[s EXCEPT !.hold=TRUE]
    \/ /\ s.target="A" /\ s'=[s EXCEPT !.target="B"]
    \/ /\ ~AssumeRemoteDurability /\ s.remoteAlive
       /\ s'=[s EXCEPT !.remoteAlive=FALSE]
AuthorityOK == s.auth="granted" /\ s.epoch=s.receipt.epoch
HoldOK == ~s.hold
SourceOK == s.source=s.receipt.source
TargetOK == s.target=s.receipt.source.target
BackupOK == s.receipt.coverage="full"
RemoteOK == s.receipt.verify="full"
RestoreOK == s.receipt.restored
FreshOK == s.backup=s.receipt.backup /\ s.manifest=s.receipt.manifest /\ ~s.expired
RetainedOK == s.retained=s.receipt.id
Gate(name, condition) == Mutant=name \/ condition
Eligible == /\ Gate("authority", AuthorityOK) /\ Gate("ignore-HOLD", HoldOK)
 /\ Gate("source-mutation", SourceOK) /\ Gate("wrong-target", TargetOK)
 /\ Gate("partial-backup", BackupOK) /\ Gate("partial-verification", RemoteOK)
 /\ Gate("restore", RestoreOK) /\ Gate("stale-receipt", FreshOK)
 /\ Gate("lost-receipt", RetainedOK)
\* Independent monitor: full PRE-state copied before any candidate cleanup.
DecisionChecks(x) == [
 authority |-> x.auth="granted" /\ x.epoch=x.receipt.epoch,
 hold |-> ~x.hold, source |-> x.source=x.receipt.source,
 target |-> x.target=x.receipt.source.target,
 backup |-> x.receipt.coverage="full", verification |-> x.receipt.verify="full",
 restore |-> x.receipt.restored,
 freshness |-> x.backup=x.receipt.backup /\ x.manifest=x.receipt.manifest /\ ~x.expired,
 retained |-> x.retained=x.receipt.id, remote |-> x.remoteAlive]
DecisionSafe(key) == s.pc # "deleted" \/ DecisionChecks(decision)[key]
\* Attempt is a proposal decision, never a filesystem operation.
Attempt == /\ s.pc="sealed"
 /\ s'=[s EXCEPT !.pc=IF Eligible THEN "deleted" ELSE "refused"]
 /\ decision'=s
Next == ((Observe \/ Seal \/ Authorize \/ Disturb) /\ UNCHANGED decision) \/ Attempt
Spec == Init /\ [][Next]_vars
Deleted == s.pc="deleted"
AuthorityCurrent == DecisionSafe("authority")
HoldRespected == DecisionSafe("hold")
SourceCurrent == DecisionSafe("source")
ExactTarget == DecisionSafe("target")
CompleteBackup == DecisionSafe("backup")
FullRemoteVerification == DecisionSafe("verification")
RestoreValidated == DecisionSafe("restore")
ReceiptCurrent == DecisionSafe("freshness")
ReceiptRetained == DecisionSafe("retained")
RemoteDurable == DecisionSafe("remote")
NoDeletion == ~Deleted
\* Each antecedent is measured in an unmutated permitted run, before the decision.
Seen(name) == CASE name="success" -> Deleted
 [] name="refusal" -> s.pc="refused"
 [] name="sealed" -> s.pc="sealed"
 [] name="signed-off-refused" -> /\ s.pc="refused" /\ s.auth="granted"
                                 /\ s.receipt.verify="none"
 [] name="source-drift-refused" -> s.pc="refused" /\ ~SourceOK
 [] name="unknown-refused" -> s.pc="refused" /\ s.receipt.verify="unknown"
 [] name="partial-refused" -> s.pc="refused" /\ s.receipt.coverage="partial"
 [] OTHER -> /\ s.pc="sealed" /\ s.auth # "none"
   /\ CASE name="authority" -> ~AuthorityOK
       [] name="ignore-HOLD" -> ~HoldOK
       [] name="source-mutation" -> ~SourceOK
       [] name="wrong-target" -> ~TargetOK
       [] name="partial-backup" -> s.receipt.coverage="partial"
       [] name="partial-verification" -> s.receipt.verify="partial"
       [] name="unknown" -> s.receipt.verify="unknown"
       [] name="failed" -> s.receipt.verify="failed"
       [] name="restore" -> ~RestoreOK
       [] name="stale-receipt" -> ~FreshOK
       [] name="backup-drift" -> s.backup # s.receipt.backup
       [] name="manifest-drift" -> s.manifest # s.receipt.manifest
       [] name="expiry" -> s.expired
       [] name="lost-receipt" -> ~RetainedOK
       [] name="remote-loss" -> ~s.remoteAlive
       [] OTHER -> FALSE
Unseen == ~Seen(Witness)
=============================================================================
