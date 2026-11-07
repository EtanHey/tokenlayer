# Imported acquisition reader — unused component

`importAcquisition(authority)` synchronously clones a caller's externally authorized
pin before IO. The pin binds canonical private directory and final manifest statPin
identities, exact manifest byte length/SHA256 (including LF), canonical receipt hash
(without LF), sourceRevision/acquisitionId, whole hash/length and external authority
receipt hash. Supply statPin key order from the producer. A self-issued hash cannot
grant read permission: caller review/allowlist authority remains external.

Only approved producer representation/order/serialization is accepted: exact keys,
UTF8 JSON.stringify + LF, no duplicates/unknown keys/alternate framing; final true,
sourceComplete false, UNKNOWN origins, valid producer topology/revision/acquisition.
The retained intent must equal the exact corresponding incomplete receipt. Directory
names must be exactly intent.json, manifest.json and declared numeric chunk files;
pending/extra/missing entries refuse. No original source path is statted or opened.

Files are opened descriptor-relative, nofollow/nonblocking/readonly; canonical
ancestor descriptors are held and their linkage rechecked. Output directory must
remain owner0700, inputs owner0600, regular/singlelink, exact immutable statPin.
The bounded name-only directory listing uses the pinned pathname between anchored
checks. This assumes trusted exclusive namespace/path lifecycle; hostile same-UID
mutation and power-loss guarantees are outside the contract. No background lease.

The factory completes one whole join using a single reusable <=1MiB payload buffer,
checks all chunk identities again at pass end, then returns a frozen closure handle
with frozen summary (ordered frozen geometry/hashes and custody/method/observedAt),
readChunk(index) and verifyWhole(). No deserialized verified record is accepted.
Internal receipt/pins stay private; caller mutation cannot alter
them. readChunk returns one freshly verified RawDocument with the exact existing
chunkDocument mapping, avoiding its extra copy. The reader retains no returned
payload; the caller must enforce one in-flight document and discard it after use.

Every operation reopens/rechecks directory, exact final/intent bytes and identities,
layout, and applicable chunk pins. Original limits: 512KiB each receipt,1024 chunks,
1MiB fixed chunks,1GiB whole. Each operation has fresh cooperative30s,8192 read calls,
attempted read-byte cap wholeBytes+4*512KiB+1028 (whole) or1MiB+4*512KiB+1028
(chunk), including EOF probes; short-read attempts conservatively consume budget.
Ancestors<=126 and listing<=1026 entries+EOF. OS blocking calls are not preemptible.
No descriptors persist between calls; elapsed network ACK time consumes no local
budget. Read-only closes independently best-effort; all refusals use a fixed code.

Call verifyWhole() again at future storage completion under current intent/owner
authority; a handle is an IO snapshot capability, not a lease, ACK ledger, stored
source or schema qualification. Empty source has0chunks/exact empty hash. Every
result retains sourceComplete:false. No writer/network/production adoption here.
