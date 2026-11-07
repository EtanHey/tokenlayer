# Durable manifest/intent/ACK core — unused ACK-stage seam

`storeAcquisition(authority, writerPins, freshLedgerPath, ch, current, signal?)`
clones source/owner/window/epoch/schema/config/scope pins and constructs the existing
RawDocumentStore with explicit streaming policy before awaiting anything. Required
`current(phase,bound,charge)` must authenticate external authority, current sole-owner
window/epoch and actual source-local/pending/state/schema/config admission, returning
exact bindingHash/admitted:true or refusing. Opaque hashes are not permission or
cross-machine fencing. There is no default admission callback, discovery or CLI.

The fresh imported reader verifies its full join. `readManifest()` returns the exact
fresh pinned final manifest bytes INCLUDING LF as format history-file-chunks-manifest-v1,
version1, locator history-file-chunks-manifest-v1:${sourceRevision}, original fixed
method/observedAt/parent receipt. It retains UNKNOWN historical origin. This explicitly
declared parent document is sent first even for an empty source, then ordered chunks.

An immutable intent binds external pins, full frozen source geometry, declared parent
and chunk metadata, exact existing raw row ID tuples and exact encodeRow bytes+LF.
Every document is reread/compared before dispatch. Files are owner0600/singlelink in
fresh owner0700 anchored nofollow namespace, ignored/outside-repo guard before writes.
Intent file fsync+strict close+directory fsync precede any put. Exact returned IDs
must match, and exclusive ACK file fsync+strict close+directory fsync precede advancing.
Intent/latest ACK identities and private modes are rechecked before write/dispatch;
all recorded file identities are swept before returning the ACK-only stage.
Every mkdir/create/write checks current admission and measured20GiB+24MiB pending+
all remaining state bytes, no purgeable credit. Intent<=2MiB, all state<=4MiB, each
local file write cooperative30s. At most1025 documents/ACKs. No payload arrays retained.
localBytes charges encoded state; the caller must additionally precharge actual
filesystem allocation, whole-source, scratch and epoch costs through current().

All put failures/wrong ACKs conservatively stop as ACK_UNKNOWN; ACK persistence
failure stops as ACK_UNRECORDED. All evidence retained. Existing/partial ledgers always
refuse without reading/replaying or rewriting them; exact recovery requires a separate
authorized resolver. Local failures are sanitized, all final closes independently
attempted. A failing writable close prevents success; cleanup cannot grant durability.

After all ACKs, current gates and a fresh full reader join, return only
ACKS_DURABLE_COVERAGE_NOT_IMPLEMENTED/sourceComplete:false. **No storage completion
receipt exists:** actual bounded FINAL raw-byte/hash/metadata readback and exact
coverage checker/resolver remain the next component. No production transport/DDL or
native/source acceptance is qualified. Existing store/manual/stream/wire limits stay
unchanged; caller enforces sole window and full source/epoch costs. Exclusive trusted
namespace required; fsync observations are not power-loss/hostile-same-UID qualification.
