# Complete raw documents, contract v1

Review building block only; schema/config attestation and real-binary adoption HOLD.
No CLI/DDL apply/production wiring/source admission. schema.sql stays outside automatic
schema:apply. Existing session_events/proxy_usage/ship/backfill/schema remain unchanged.

put accepts an already acquired complete Buffer with full expected SHA256/byte length.
It never reads/parses/reserializes JSON. Existing RAW_BYTES/encodeRow preserves root,
framing, whitespace, BOM/CRLF, multibyte/binary bytes and absent final LF; transport LF
is outside raw. Restore binary bytes via CH binary output or hex(raw), not text decode.

Revision ID is lowercase SHA256 of UTF8 JSON.stringify, no LF, of fixed tuple
["raw-document-revision-v1",custodyMachine,sourceLocator,format,formatVersion,originalHash,originalBytes].
Acquisition ID hashes ["raw-document-acquisition-v1",revisionId,method,observedAt,receiptHash]
identically. Replay exact manifest fields; observedAt is acquisition UTC, never an
event clock. Receipt hash references evidence, not its truth or source completeness.
ReplacingMergeTree(revision_id,acquisition_id) gives logical replay via FINAL after
the finite1000-block token window; physical duplicates can persist until merge. New
bytes give a new revision; new acquisition evidence remains separate. Cross-path/Mac
revisions stay distinct; equal hash+length is only a candidate byte relationship.
Archive locators must bind container hash/member name/ordinal in a future adapter.
Origin machine/path/proof and historical writer version stay UNKNOWN. No inferred
event timestamp/provider/status/latency/credential. Format version UNKNOWN if unproved.

Bounds: source<=16MiB, exact encoded row including LF<=8MiB. Escaping can refuse
smaller inputs. UTF8 metadata caps: custody/format/version128, locator16384, method256,
observedAt24 canonical ISO UTC. Empty/control/lone-surrogate strings refuse; no truncation.
Input/config snapshots precede await. Per-instance concurrent put refuses PUT_IN_FLIGHT;
lock releases on every result. It cannot coordinate other instances/processes.

RawDocumentStore(ch) remains manual. It retains unchanged diskVerdict(2*charge,
free_space+keep_free_space), including35GiB physical floor; independently unreserved
must cover2*charge+ceil(2*charge/4)+14GiB temporary/overhead/margin budget. Only this
manual physical estimate restores reserve; reserve never proves dispatch headroom.
RawDocumentStore(ch,'streaming') explicitly selects the distinct fixed policy:
installed reserve>=15GiB and unreserved>=2GiB+384MiB+5*charge, checked each put.
charge is exact serialized request including LF. No env/numeric override or test bypass.
Both free_space and unreserved already exclude reserve on reviewed CH26.10; pending
reservations can lower unreserved. Require0<unreserved<=free_space; safe canonical
unsigned-decimal measurements; one disk named default. Missing/negative/unsafe/zero
free or usable/saturated/inconsistent/multiple-disk results refuse. Manual reserve0
is legitimate; streaming requires15GiB. Policy membership/constraints/engine arguments/
TTL/partition attestation remains HOLD; current schema checks do not establish them.

Pre-send abort refuses. In-flight synchronous CH call settles; errors yield ACK_UNKNOWN
without checkpoint/retry. Replay only identical pinned acquisition under owner authority.
No partial chunks. Separate manifest integration must bind scope/stable nofollow stat/
complete bytes/evidence, M4 per-source local floor/state/epoch/sole-writer and checkpoint
only ACK. Bind metadata spans to revisionId without session_events. API admission is
a measurement, not a reservation or batch pipeline. Capacity audit belongs to Terra;
real isolated binary/constraint/invalidUTF8/physical-vs-FINAL proof remains required.
