# Private bounded metadata projection (review pending)

Run `bun src/metadata/main.ts pinned-input.json /existing/private-parent/fresh-output`.
The CLI reads only explicitly pinned local LF records. It has no ClickHouse, native ingester,
pricing, Drive, archive decoder, service or checkpoint connection. Exit 0 means only the declared
projection scope completed; exit 2 retains an UNRESOLVED manifest, exit 1 rejects setup.
No full-history/source acceptance follows from any exit code.

Input is a <=1MiB JSON manifest, version 1, nonempty `scope`, and 1..128 `sources`.
Each source requires:

```json
{
  "path": "/private/exact-records.ndjson",
  "inputSha256": "<SHA256 of exact input LF bytes>",
  "format": "raw",
  "provider": "codex",
  "admission": "admitted",
  "admissionEvidenceHash": "<SHA256 of admitting receipt>",
  "custodyMachine": "M1",
  "originMachine": "UNKNOWN",
  "originProof": "UNKNOWN",
  "containerDriveId": "UNKNOWN",
  "containerHash": "UNKNOWN",
  "memberPath": "original/nested/member.jsonl",
  "memberHash": "<SHA256 of original decoded member or UNKNOWN>",
  "physicalRepresentationHash": "<SHA256 of original physical representation>"
}
```

Provider is `codex` or `claude`; admission is `synthetic`, `retained`, `admitted`, or
`witness`. Retained/admitted raw inputs require an admission receipt pin. A plain full physical
member has input/member/physical hashes equal and coordinates computed from exact LF bytes.
For an admitted subset, supply `coordinatesPath` and `coordinatesSha256`, with one LF coordinate
object per exact raw LF record, in the same order:

```json
{"originalLFLine":17,"decodedOffset":1234,"recordHash":"<raw LF SHA256>","recordBytes":246}
```

The subset's input hash is its export hash; original member and physical representation pins
are declared provenance from the admission contract, not independently reread sources. Mapping
hash, count, raw-record bytes/hash and coordinate shape must verify. Start with the actual
original line-1 header to establish owner; a subset without it stays UNKNOWN/UNRESOLVED.
`NOT_APPLICABLE` is valid for absent local container fields; uncertainty must use `UNKNOWN`.
Origin needs actual evidence distinct from custody; cwd alone never assigns an origin machine.
The manifest joins exactly one physical/member identity per source. Split mixed-member exports.

`witness` accepts only the retained metadata packet schema, never treats it as original raw.
It requires `witnessReceiptHash`; the caller first verifies compressed packet hashes against that
receipt, then pins the small decoded packet as `inputSha256`. Original `line` remains distinct
from packet line, output ordinal and decoded packet offset. Raw offset/hash/bytes and original
field presence remain UNKNOWN/UNRESOLVED where the old packet lost them. Optional
`upstreamUninspected: [{line,bytes,sha256}]` carries receipt-only oversize gaps. These rows are
not inspected by this CLI, and their hashes are attributed to that receipt.

Outputs in a new 0700 directory: `metadata.ndjson`, `candidates.ndjson`, `manifest.json`, and a
private on-disk candidate index, all 0600. Repository outputs must be gitignored before the
first write. Existing output directories are refused. Outputs should remain private, outside
repos by preference. The manifest pins both NDJSON hashes and retains scoped counts/status.
Only manifest status authorizes consumption; earlier rows remain provisional until final hash
and source-stability checks finish. Interrupted processes can leave rows without a manifest;
those outputs are never complete. Errors do not print raw source content.

The scanner reads 64KiB chunks and retains at most 1MiB of raw bytes per LF record (temporary
concatenation/JSON objects add bounded overhead). Larger records are streamed to SHA256 with
byte/offset/LF receipts, UNINSPECTED, never zero usage. Context continuity becomes UNKNOWN after
any uninspected row. The native ingester's existing 1MiB cap is untouched. There is no arbitrary
JSON parsing of 11–13MB compacted bodies, and no claim those bodies have been ingested.
Manifest size, one current record/context, and SQLite's 1MiB page cache bound memory independently
of record count; candidate identities live on disk. Each occurrence remains in metadata; repeated
non-null stable references generate candidate receipts only. No parent/child union, clock dedup,
usage subtraction, delta derivation, TTL inference, pricing, or added reasoning subsets occurs.

Presence records distinguish absent, null, explicit zero and value. Numeric/null usage objects
are preserved verbatim as parsed objects, including unknown native numeric fields, with recursive
presence. Unsupported usage shapes are hashed/UNRESOLVED, never emitted as tool/chat content.
Raw field values retain native names. Derived preceding-response references carry their source
coordinate and basis, separately from literal refs. They do not prove inherited/live classification.
First physical header ownership is immutable; later headers are emitted separately. Actual native
clocks, task/turn context, model/client/tier/cwd and stable refs are metadata only. Missing fields
remain missing; a packet-supplied null is never promoted to proved raw null.

Synthetic suite: `bun test tests/metadata`. Optional private witness check:
`TOKENLAYER_METADATA_WITNESS=/private/witness bun test tests/metadata/witness.test.ts`.
This verifies existing packets only, with no native originals, production DB or Drive reads.
