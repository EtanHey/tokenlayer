# Backup before delete — SPEC_ONLY

Status: R1 candidate for fresh final R2 independent review. This is a proposed
operating contract, not conformance proof for a purge program. Wave2 PURGE HOLD
is unchanged. `deleted` is a model decision; nothing here deletes user data.
No tests are removed, no executable purge binding is supplied or licensed.

Run only the local model checker (no downloads, services or payloads):

    python3 formal/backup-before-delete/check.py --evidence /absolute/authorized/evidence

The jar at `~/.cache/tla/tla2tools.jar`, resolved Homebrew Java binary and exact
`java -version` output must match toolchain.json. One TLC worker, 512 MiB heap,
64 MiB TLC default offheap, 90 seconds/config, 900 seconds/invocation. Fixed
fingerprint polynomial 0 and seed 1; fingerprint collision risk is not zero.
Every invocation creates a new retained directory. Every case has its own model,
config, trace namespace, temporary directory, raw log, command and exit receipt.
Warning/error diagnostics are rejected across case, prefixes and JVM formats;
SANY parse errors, fatal/exception channels and parse-failed messages get no credit.
Counts require one well-formed summary and integers generated >= distinct > 0;
commas must group thousands correctly. Missing/malformed counts, wrong property,
wrong exit or timeout gets no credit. Only exact expected diagnostics are allowed.

## Goal, bounds and environment

Goal: a proposed attempt requires exact current evidence and authority. Steps:
observe independent coverage/verification/restore outcomes; retain a bound receipt;
authorize; allow intervening disturbances; decide once. All source identities are
synthetic symbols. No implementation source is imported or run.
Round: one implementation owner, sequential; tools: Codex Sol/high, local TLC.
Depends on: reviewed documentary contracts; independent review remains NOT_RUN.

One source A with two versions/hashes, alternative proposed target B; one backup
and one manifest each with two versions/hashes; one receipt ID with retained
reference 1 or replaced/lost reference 2; authority none/granted/revoked with two
epochs; three coverage and five verification outcomes; Boolean restore, expiry,
HOLD and remote availability. Disturbances are monotone and occur only after seal.
No step cutoff or symmetry reduction. Terminal refused/deleted states stutter.
No fairness or liveness assertion: an operator may never authorize or attempt.
This does not model arbitrary repeated generations, crashes, remote reordering,
symlinks, inode races, adversarial hashes, free space or physical filesystem effects.

`full` verification abstracts *trusted full-byte observation*, not a success label.
Coverage of every original is distinct from hashing all bytes of a partial archive.
Restore TRUE means validated samples bound to this backup, not a complete restore.
The observer and operator are trusted external actors, not an authentication proof.
Source/backup/manifest records include identity, version and hash; changes make the
retained receipt stale. No refreshed receipt is issued within this bounded run.
Attempt evaluates current guards atomically. An independent `decision` variable
copies the complete PRE-state (`decision'=s`) in the same transition; every other
action leaves it unchanged. Ten properties evaluate independently written checks
against that captured record, including authority epoch, all receipt fields and
remote availability. They never derive evidence from post-decision cleanup.
The full pre/post records are effect-audited in R1 evidence. Ten additional erase
controls bypass a prerequisite and repair its visible fields while entering deleted;
all must fail the corresponding pre-decision obligation. Source erasure retains
the exact review A rewrite and passive badPreSource latch. Original mutants and
all 22 witnesses remain. These are synthetic candidate copies, not purge changes. The source must be quiescent between
that decision and any real unlink; the scripts do not implement this atomic step.

AssumeRemoteDurability=TRUE excludes remote loss between observation and decision.
This is an environmental promise, not a property of receipt custody or Drive.
The remote-loss environmental mutant removes that promise without changing the
decision guard: RemoteDurable fails despite full verification and retained custody.
No claim of durability after deletion is made; terminal states freeze the snapshot.
A remotely durable retained receipt store is also abstracted; no fsync is proven.

## Obligations and dedicated controls

| Invariant | Mutant | Unmutated reachable trigger |
|---|---|---|
| NoDeletion (HOLD config) | hold-no-deletion / ignore-HOLD gate | HOLD; hypothetical success separately |
| AuthorityCurrent | authority | revoked authority/changed epoch |
| HoldRespected | ignore-HOLD | raised HOLD after seal |
| SourceCurrent | source-mutation | changed exact source version/hash |
| ExactTarget | wrong-target | proposed target B, receipt A |
| CompleteBackup | partial-backup | partial original coverage |
| FullRemoteVerification | partial-verification | partial byte verification |
| RestoreValidated | restore | no validated restore |
| ReceiptCurrent | stale-receipt | backup drift, manifest drift, expiry separately |
| ReceiptRetained | lost-receipt | retained receipt identity lost/replaced |
| RemoteDurable | remote-loss (environment) | remote loss after receipt |

Baseline Hold.cfg checks no deletion plus all ten safety properties. Permitted.cfg checks all
ten safety properties with initially released HOLD; it is hypothetical only. Dedicated Unseen
invariants must fail with exit 12 for each antecedent, success, refusal, seal,
unknown/failed verification, each freshness cause and several actual refusals.
Each mutant checks only its designated property; the other guards remain intact.
NoDeletion shares the HOLD bypass mechanism but has its own named sensitivity run.

## Source / operating contract map (read only)

These are absolute documentary sources; there is no executable conformance adapter.
Source/tool/model/config/log hashes and unchanged-source recheck are in the sealed
implementation evidence. Review claims below remain historical, not re-executed.

| Contract | Source join | Mapping / gap |
|---|---|---|
| Exact source + target | tokenlayer/docs.local/capacity-recovery/step1_purge.py:26-49; step3_purge.py:29-47; voicelayer/docs.local/m1-storage-backup/purge_verified.py:25-35,49,63 | identity/hash rechecks map to source gate; check-to-rm pathname race excluded by proposed atomic decision |
| Full coverage, backup/manifest custody | step1_purge.py:10-17; step3_purge.py:10-23; purge_verified.py:19-27,37-45 | Step1/3 use prior byte proofs + fresh metadata; Wave2 rehashes remote bytes; model demands exact current tuples |
| Restore validation | step1_purge.py:14-15; step3_purge.py:14-17; Wave2 CLAUDE-REVIEW.md restore sections | first two rehash restore samples; Wave2 relies on sealed historical evidence, not fresh restore validation in purge code |
| Authority + HOLD | purge_verified.py:21-24; PURGE-HOLD.md | Wave2 checks routed approval, not HOLD or current revocation/expiry; Step1/3 have no in-script operator/HOLD guard; these are proposal-only gates |
| Receipt retention | step1_purge.py:9,33,69; step3_purge.py:9,34,63; purge_verified.py:55,60,67 | exclusive no-rerun journals, differing fsync intervals; no proof of crash-atomic deletion/receipt custody |
| Remote durability | STEP1-CLAUDE-REVIEW.md follow-ups; STEP3-CLAUDE-REVIEW.md notes; Wave2 CLAUDE-REVIEW.md | borrowed copies, metadata drift, external dependencies and historical observations are not future retention promises |

The three review reports were read only. Wave2 review explicitly approves technical
custody while denying execution under HOLD; C1 unsealed transitive helpers, C2
non-per-file handle checks, C3 stale custody label remain outside this abstraction.
No native target, private inventory, backup content, credentials or remote API was
read. The model cannot grant authority or turn these source gaps into safety proof.
