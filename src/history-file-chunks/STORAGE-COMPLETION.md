# Durable storage completion — unused caller-authorized protocol

finalizeStorage(input,boundedClient,current,signal?) clones input/config before any
await. Input binds original ImportAuthority/WriterPins snapshots plus private ledger
directory statPin, exact intent hash, ACK-stage outcome+hash and externally issued
completion authority hash. Required current(context) must AUTHENTICATE that issued
completion/ACK-stage scope, current sole owner/window/epoch/schema/config and full
source/allocation/state budget. Self-hashes and typed ACK records cannot authorize
writes; no default callback or cross-machine fencing is implemented.

The actual safe reader reconstructs exact canonical intent and ordered ACK bytes,
including declared parent manifest and zero-chunk manifest ACK. Directory/ancestors,
uid0700/0600/singlelink/nofollow/EOF/content/stat/closed-layout checks authenticate
against those external pins. Missing, unknown, partial, extra, noncanonical or
drifted state refuses; no recovery/rewrite/reclock/retry. Original snapshots must
retain canonical property order. A per-pass30s/8192read/4MiB attempted-data cap plus
<=1027one-byte EOF probes is a refusal profile, not maximum-size acceptance.

Concrete fresh point-key FINAL evidence is mandatory, no caller-supplied coverage
result. After LAST awaited COMPLETE admission, both output Git guards, source whole
join and full ledger checks run synchronously. Separate ledger manifest.json.pending
is written/fsynced/strictly closed plus directory fsync. Another source whole join,
full ledger/content/identity sweep and physical20GiB+24MiBpending+remaining write check
precede existing atomic NOOVERWRITE commit to ledger/manifest.json and postcommit
directory fsync. Both files are storage-completion namespace, NOT acquisition output.
Producer sourceComplete:false remains immutable; storage receipt has its own kind.

Existing pending/final receipt refuses. Failure after commit dispatch returns
STORAGE_COMPLETION_COMMIT_UNKNOWN, retains evidence and never retries/deletes. Current
admission covers the terminal synchronous critical section, with no later await;
continuous exclusive owner/namespace lifecycle remains external. Fsync observations
are not power-loss or hostile same-UID atomicity guarantees. localBytes64KiB covers
bounded completion bytes; caller additionally owes actual allocation/source/epoch costs.

Actual owned FS+loopback fake SQL proof is not real backend/source acceptance. No CLI,
service, native, CH server, pilot or production adoption. Separate admitted backend
byte/ACK/FINAL qualification and full live schema/authority verification remain HOLD.

API compatibility delta: finalizeStorage now accepts the explicit RawClickHouse from
raw-document/client. Its captured-config clone remains bounded and receives the same signal.
Completion semantics and all source/ledger/FINAL contracts are unchanged.
