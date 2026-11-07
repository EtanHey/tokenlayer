# Opt-in bounded HTTP and FINAL evidence — unused

Flat ClickHouseConfig requestTimeoutMs/maxRequestBytes/maxResponseBytes must all be
positive safe integers, capped60s/16MiB/2MiB. An opt-in client snapshots/freezes flat
config; RawDocumentStore's existing clone preserves these primitives. Its insert
passes the optional signal to this real transport. Unset clients retain legacy
fetch/text/error/signal behavior. No env default or production caller changes.

Bounded requests charge actual URL (including encoded insert query/dedup token) plus
body bytes, including encodeRow+LF. Redirects refuse. Abort/deadline covers fetch
AND streamed response; exact response limit/UTF8/content-length/HTTP exception and
empty insert-ACK framing are checked. All bounded errors are fixed sanitized codes;
store insert failures remain ACK_UNKNOWN with no retry. In-memory caller input and
encoder allocations are separate from transport byte limits; raw store caps remain.

readFinalCoverage clones typed expected metadata and client config; requires an
explicit bounded profile and required fresh authorize callback per batch. It cannot
grant storage completion. At most1025 keys,128/batch, strict SQL<192KiB INCLUDING
FORMAT/settings, request<=192KiB/response<=1MiB/deadline<=5s. SQL readonly2,threads1,
execution3s,memory64MiB,rows(batch+1),result512KiB/throw. Only exact point-key FINAL,
byte-ordered IDs, no raw payload returned. All17 schema columns are covered:16 exact
metadata fields plus ACTUAL raw length/SHA256. Canonical integer string or safe
integer numeric responses accepted; malformed/unsafe/missing/extra/duplicate/key/
order/framing mismatches refuse. Evidence hash is integrity, never authorization.

Proof: actual owned loopback HTTP, synthetic SQL semantics; no real CH/FINAL/backend,
native/source/adoption qualification. Caller still owes fresh full schema/config,
sole-owner/epoch and complete allocation authority; no fencing or maximum-size claim.

ExpectedDocument is a trusted-input contract: callers supply unchanged describe() output from an authenticated safe-reader document. This lookup compares stored columns, raw hash and length. It does not validate or certify role/index/offset/wireBytes annotations or source topology; the safe-reader/ledger reconstruction in finalizeStorage supplies that separate boundary. Its evidence cannot grant completion or authority.
