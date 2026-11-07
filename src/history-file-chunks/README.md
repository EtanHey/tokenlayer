# history-file-chunks-v1 — acquisition only

Separate explicit representation, not a fallback inside RawDocumentStore. No CLI,
root discovery, native/provider/Drive access, DB writer or source deletion. PR119's
five files/head stay unchanged. This module reads only the one explicit FilePin path
per call; a caller's reviewed allowlist receipt is evidenceHash, not self-issued read
permission. Current proof uses owned synthetic files only.

FilePin requires canonical absolute custody path, exact wholeHash/wholeBytes and six
BigInt decimal stat pins (dev,ino,size,birthtimeNs,mtimeNs,ctimeNs), custodyMachine,
sourceFormat, method, fixed canonical UTC observedAt and external evidenceHash. The
caller supplies all pins/authority. Only named fields are copied, stat keys in the
listed order. Missing/unsupported/unsafe pins refuse; no automatic clocks or discovery.

A single nofollow/nonblocking regular-file descriptor (single hardlink) stays open.
First pass verifies complete expected hash/length/EOF/stat and inventories chunk pins,
without payload persistence. Second pass rereads bounded chunks from the same fd,
verifies every first-pass hash and the final wholehash/length/EOF/stat/path/ancestors.
No JSON parsing, whitespace/UTF8/newline normalization or dropped final tail. Two
source payload passes only; metadata identity checks do not reopen source payload.

Closed bounds: original<=1GiB, fixed chunks1MiB, count<=1024, manifest<=512KiB,
cooperative30s deadline checked at reads/writes/commit admission. Empty file has0
chunks and the exact empty hash. OS blocking IO itself cannot be forcibly interrupted.
These are NEW file-representation limits; old16MiB-document/8MiB-wire caps unchanged.
Worst raw JSON escaping is6*1MiB, leaving >2MiB for metadata under the old8MiB cap;
chunkDocument metadata is tightly bounded (<64KiB). Old store still charges/checks its
EXACT encoded request. It is never called here.

Fresh output directory0700, files0600, descriptor-relative nofollow/exclusive writes,
canonical held ancestor identity and exact mode checks. Reuse existing Git ignore/
outside-repo guard, native custody primitives, physical20GiB floor and24MiB pending
allowance. Before output creation and each write reserve all remaining source bytes
plus two512KiB manifests; no free-space override. First pass precedes output-space
reservation; future intake must perform its full source-local pre-read admission.
No purgeable credit, path overwrite, extraction, source rewrite, removal or cleanup.

intent.json has acquisitionComplete:false/sourceComplete:false. Verified chunks are
000000.bin.. in source order; any failure retains intent/chunks/pending evidence.
Only after the full second-pass join and identity checks does atomic no-replace
rename publish manifest.json. It has acquisitionComplete:true/sourceComplete:false.
Acquisition completion is NOT stored/accepted-source completion. Atomic visibility
and file fsync are not a directory-rename power-loss durability qualification; hostile
same-UID tampering remains outside this bounded snapshot contract.

sourceRevision = SHA256(UTF8 JSON.stringify, no LF, of
['history-file-chunks-v1',custodyMachine,path,sourceFormat,wholeHash,wholeBytes]).
acquisitionId = same hash of [sourceRevision,stat,method,observedAt,evidenceHash].
Manifest uses fixed construction order; receiptHash hashes JSON.stringify(manifest)
without LF. Intent and final receipts differ explicitly in acquisitionComplete only.
Reruns require identical pinned metadata and a fresh output namespace; no overwrite
or new clocks/IDs to force admission. Physical aliases/cross-Mac copies retain separate
source revisions; equal wholehash+length is candidate byte equality only. Origin
machine/proof/originalPath are UNKNOWN. No event/native/billing dedup inference.

verifyReassembly incrementally checks exact count/index/contiguous offsets/lengths/
chunkhashes/wholehash and returns joinVerified/sourceComplete:false. No partial output
or success return on missing/reordered/overlapping/changed chunks. chunkDocument takes
a complete acquisition receipt and one verified chunk, maps it to the explicit format
history-file-chunks-v1/version1 and stable sourceRevision:index locator for a FUTURE
reviewed writer. It never substitutes that row for the entire source.

Next writer requirements are in the sealed root WRITER-HANDOFF.md: schema/config
attestation, sole-writer window, intent/ACK ledger, source-local/epoch/state/hub budgets,
coverage and whole join before source completion. Acquisition is not ingestion.
