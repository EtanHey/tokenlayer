# Private bounded metadata projection (review pending)

Run `bun src/metadata/main.ts pinned-input.json /existing/private-parent/fresh-output`.
The CLI reads only explicitly pinned local LF records. It has no ClickHouse, native ingester,
pricing, Drive, archive decoder, service or checkpoint connection. Exit 0 means only the declared
projection scope completed; exit 2 retains an UNRESOLVED or INVALID_NON_CONSUMABLE manifest; exit 1 rejects setup/final publication.
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
hash, count, exact raw-record bytes/SHA256 and coordinate shape must verify. Original line and decoded
offset must strictly increase; adjacent original lines require exact offset adjacency. Skipped lines
require at least one LF byte each; duplicate/reversed/overlapping coordinates fail closed. Codex requires the actual
original line-1 header to establish owner; a subset without it stays UNKNOWN/UNRESOLVED.
Claude uses the first actual user/assistant/system/progress/queue-operation record with a nonempty
string sessionId, with basis `first_session_record` and its coordinate; no filename-derived owner.
`NOT_APPLICABLE` is valid for absent local container fields; uncertainty must use `UNKNOWN`.
Origin needs actual evidence distinct from custody; cwd alone never assigns an origin machine.
The manifest joins exactly one physical/member identity per source. Split mixed-member exports.

`witness` accepts only the retained metadata packet schema, never treats it as original raw.
It requires `witnessReceiptHash`; the caller first verifies compressed packet hashes against that
receipt, then pins the small decoded packet as `inputSha256`. Original `line` remains distinct
from packet line, output ordinal and decoded packet offset. Raw offset/hash/bytes and original
field presence remain UNKNOWN/UNRESOLVED where the old packet lost them. Optional
`upstreamUninspected: [{line,bytes,sha256}]` carries receipt-only oversize gaps. These rows are
not inspected by this CLI, and their hashes are attributed to that receipt. Before projecting any witness
row after the earliest upstream gap, carried context continuity becomes UNKNOWN; original LF lines,
packet lines and output ordinals remain separate. Full-source continuity is UNKNOWN for witness rows.

Outputs in a new 0700 directory: `metadata.ndjson`, `candidates.ndjson`, `manifest.json`, and a
private on-disk candidate index, all 0600. Repository outputs must be gitignored before the
first write. Existing output directories are refused. Outputs should remain private, outside
repos by preference. The manifest pins both NDJSON hashes and retains scoped counts/status.
Consumers must JSON-validate the final manifest and verify both NDJSON hashes. Earlier rows remain
provisional until final hashes and source-stability checks finish. The final manifest is fsynced to a
private temporary file, then atomically renamed after both NDJSON files are fsynced.

- Exit 0, `SCOPED_PROJECTION_COMPLETE`, consumption `SCOPED_METADATA`: declared metadata scope only.
- Exit 2, `UNRESOLVED`, consumption `PARTIAL_METADATA_ONLY`, no errors: hash-verified partial metadata
  may be consumed under the lead ruling. Preserve each row's gaps, fullSourceContinuity and coordinates
  and each source/member's unresolved list, continuity and gap-coordinate reference. Missing data stays
  UNKNOWN. This never authorizes whole-corpus totals, provider shares, source acceptance or subtraction.
- Exit 2, `INVALID_NON_CONSUMABLE`, consumption `NONE`: hash/stability/pin or coordinate mismatch,
  interrupted/unreadable input, or output-cap failure. Never consume even as partial metadata.
- Exit 1, missing or malformed manifest, interrupted process, or output hash mismatch: never consume.

The source acceptance HOLD remains in every state. Interrupted processes can leave rows without a manifest;
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
presence. Native usage scalar strings `service_tier`, `inference_geo` and `speed` are also retained
through field presence without suppressing numeric counters; numeric `server_tool_use` stays native.
Other unsupported usage shapes are hashed/UNRESOLVED, never emitted as tool/chat content.
Raw field values retain native names. Derived preceding-response references carry their source
coordinate and basis, separately from literal refs. In raw mode derived carried responseRef is excluded
from stable candidate keys; literal refs remain candidates. Witness response_ref stays extract evidence. They do not prove inherited/live classification.
Codex original-line-1 header ownership is immutable; later headers are emitted separately. Actual native
clocks, task/turn context, model/client/tier/cwd and stable refs are metadata only. Missing fields
remain missing; a packet-supplied null is never promoted to proved raw null.

Synthetic suite: `bun test tests/metadata`. Optional private witness check:
`TOKENLAYER_METADATA_WITNESS=/private/witness bun test tests/metadata/witness.test.ts`.
This verifies existing packets only, with no native originals, production DB or Drive reads.

Output limits: manifest `maxOutputRows` defaults to 10,000 (1..1,000,000, including upstream receipts).
Preflight reserves 64KiB per capped row for both NDJSON files and the manifest, plus 16KiB per row
and 1MiB for scratch SQLite. These are hard budgets, not average-output forecasts; a large encoded
row can exhaust the byte budget sooner. Each encoded write is <=8MiB. Physical free blocks on the
actual output volume must cover the entire budget plus a 20GiB floor and 24MiB pending reserve.
Every file write and scratch insert/commit rechecks the floor with bounded pending bytes; no
purgeable-space estimate is used. External writers can still consume space concurrently; any I/O
failure invalidates output. SQLite is scratch only: synchronous OFF, journal OFF, fixed page-count
cap, <=256 output rows per transaction, 1MiB cache. No production database settings change.
Safe reason codes identify setup/runtime failures without paths or raw payloads.

Actual export path remains blocked: no admitted-raw exporter exists. The minimum next adapter is
a separately reviewed bounded compressed-member -> exact decoded LF + coordinate pin builder that
verifies physical compressed SHA256 through decoder success and decoded member SHA256. It must
not infer that link from supplied pins alone. Design and callback custody: R1 implementation receipt
at root docs.local/full-history/metadata-projection/REVISION-R1.md. The builder below implements
that narrow compression link pending lead review; the admitted-raw exporter remains missing.

## Bounded compressed-member pin builder (review required before actual use)

`bun src/metadata/build-member-pin.ts <builder-input.json> <fresh-private-output-dir>`
or `await buildMemberPin(manifestPath, outputPath)`. This local-only adapter reads one
explicit physical member. It supplies no admission decision, enumeration, Drive read,
native queue access, retained-row exporter or actual-export authorization.

Builder input requires `version:1`, `scope`, `admission` (`admitted` or `synthetic`),
`sourcePath`, `admissionReceiptPath`, `admissionReceiptSha256`, and these three objects:

- `identity`: provider (`codex`/`claude`), custodyMachine, originMachine, originProof,
  containerDriveId, containerHash, memberPath, memberHash (decoded SHA256),
  physicalRepresentationHash (compressed SHA256). Unknown provenance stays `UNKNOWN`.
- `physicalIdentity`: numeric dev, ino, size, mtimeMs, ctimeMs from the admitted file.
- `coordinates`: firstLFLine=1, decodedOffset=0, decodedBytes, records. Only a full
  decoded physical member is supported; no subset/archive/tar reconstruction.

The explicit pinned receipt must contain `version:1`,
`kind:"tokenlayer-member-admission"`, and matching scope, admission, identity,
physicalIdentity and coordinates. Hash equality verifies receipt custody, not the
authority or truth of an admission decision. The lead/exporter supplies that receipt;
there is no automatic admission. Synthetic receipts are only for synthetic fixtures.

`limits` requires compressedBytes (1..16GiB), decodedBytes (1..64GiB), ratio (>0..1M),
rows (1..1M), millis (1..600000), outputBytes (1..128GiB). These are ceilings, not
allocation targets. Physical preflight also reserves 20GiB + 24MiB pending + the
entire outputBytes cap; every write rechecks physical blocks plus pending/write bytes.
Budgets include decoded bytes, sidecar and final manifest. Inputs/receipts are nofollow,
regular, stable files; manifest/receipt reads are bounded to 1MiB. The compressed
descriptor is opened once, hashed and fed to real `zstd -dc -q` with backpressure.
Decoded records are streamed and hashed without JSON parsing, including oversize rows.
Non-LF terminal bytes, failed decode, wrong pins, instability or any cap invalidate
the run. Decoder stderr is drained/discarded with a 64KiB cap and never echoed.

Only atomically published `manifest.json` completes the builder. It is also the
projector input, linking input/receipt hashes, physical identity, successful decode,
decoded SHA256 and exact identity sidecar SHA256; raw admission stays explicit.
`decoded.ndjson`, `coordinates.ndjson` and `.pending` files alone are provisional.
Consumers must verify the final manifest and both file hashes before projection.
Files are 0600 in a fresh 0700 directory; in-repo output must already be gitignored.
There is no source acceptance or export-green claim: `rawHistoryAcceptance` stays HOLD.

## Gemini document metadata export v1 (lead review required)

Run `bun src/metadata/gemini-main.ts pinned-gemini.json /private/parent/fresh-output`.
This separate entry uses the reviewed Gemini reader; `main.ts` remains LF-only.
No Gemini JSON/JSONL is admitted to `session_events`. No database, candidate index,
service, native producer, network or source enumeration is invoked.

Input is a bounded (1MiB) UTF8 JSON manifest with exactly these fields:

```json
{
  "version": 1,
  "kind": "tokenlayer-gemini-json-export-input",
  "scope": "synthetic-example",
  "maxOutputRows": 2,
  "expectedMessages": 2,
  "expectedSessionId": "synthetic",
  "source": {
    "path": "/private/exact/chat.json",
    "provider": "gemini-cli",
    "sourceFormat": "gemini-chat-json",
    "coordinateKind": "json-utf8-span-v1",
    "admission": "synthetic",
    "custodyMachine": "declared-custody",
    "originMachine": "UNKNOWN",
    "originProof": "UNKNOWN",
    "originalPath": "UNKNOWN",
    "sourceRoot": "/private/exact",
    "rootKind": "native-gemini-cli-tmp",
    "documentBytes": 123,
    "documentHash": "<exact physical SHA256>",
    "stat": {"dev":"0","ino":"0","size":"123","birthtimeNs":"0","mtimeNs":"0","ctimeNs":"0"}
  }
}
```

Replace placeholders with exact source pins; `geminiStatPin(lstatSync(path,{bigint:true}))`
produces the six stat strings. `expectedMessages` binds every original array element,
including unsupported elements; `maxOutputRows` is required, 1..10000. Non-synthetic
`retained`/`admitted` inputs also require `source.admissionEvidenceHash`, the admitting
receipt's SHA256 for this exact scope/document/stat/provider/format/span contract.
The hash binds evidence; this CLI does not attest its authority, authorize a native read,
or verify its assertions. A legacy LF admission receipt is not a Gemini admission.
Extra manifest/source/stat keys, including LF mapping fields, are rejected.

Complete source validation finishes before output creation. Source bytes are never
reserialized. Reader caps remain 2MiB, depth64, 100000 tokens, 10000 messages and 1000ms.
Each output row retains the reader's exact original UTF8 document/span coordinates,
field hashes and six recorded token presence/precision states. No arithmetic, defaults,
dedup, pricing, inferred owner/account/machine/worktime or lifetime acceptance occurs.
Root session/project/lifecycle fields remain independent in the final document receipt.
Missing or unsupported metadata stays explicit in root/row gaps; repeated IDs retain
separate pointer occurrences. Unknown historical origin/writer remains UNKNOWN.

`metadata.ndjson` and atomically published `manifest.json` are 0600 in a fresh
0700 directory. The Gemini-only `GeminiOutput` helper holds ancestor/output directory
FDs; actual opens use no-follow descriptor-relative syscalls. Per-write Budget checks
validate held edges and measure physical blocks on the held volume, preserving the
20GiB floor, 24MiB pending and full row/byte/scratch reservation. Final publication
uses descriptor-relative atomic no-replace rename; an existing receipt is never replaced.
No path-based write/publish or shared `privateOutput`/`Budget.manifest` is used here.

Git discovery is fail closed before mkdir: successful discovery requires a successful
quiet ignore check. Normal outside-repo requires an exact C-locale not-repository
response plus an explicit no-.git check through every ancestor; any other Git/config/
trust/probe state refuses. Git discovery/config environment overrides refuse rather
than being cleared. `GIT_PAGER` remains allowed with explicit `--no-pager`.

Native bridge compatibility: Bun1.4.3, Darwin arm64/x64 libSystem `__openat` (fixed
mode ABI), mkdirat, fstatfs64 and renameatx_np(RENAME_EXCL); Linux x64 glibc openat,
mkdirat, fstatfs and renameat2(RENAME_NOREPLACE). No install/compiler/global change.
Missing symbols, unsupported platform/flag/filesystem or native error refuse; no
path-based fallback. Darwin arm64 synthetic CLI/syscalls qualified locally; Darwin
x64/Linux CI are NOT_RUN here. Standard Bun Ubuntu-x64 CI can exercise these same
focused suites; unsupported platforms must refuse. The FFI dependency is experimental
([Bun documentation](https://bun.sh/docs/runtime/ffi)); no general production-runtime
qualification follows from these synthetic tests.

Held FDs prevent redirection through later path substitutions; identity checks refuse
observed changes at the tested directory/ancestor latches. This is not protection
against arbitrary same-UID process/file tampering, nor proof that multi-syscall initial
directory acquisition is atomic. Parent/policy changes outside the checked intervals
are not a general filesystem adversary qualification. No recovery/cleanup deletes
unrecognized artifacts. Shared LF custody weaknesses remain separately tracked.

Success exits2 with `exportComplete:true`, `complete:false`, `UNRESOLVED`, consumption
`PARTIAL_METADATA_ONLY`, and source/raw acceptance HOLD. Consumers must validate schema
`tokenlayer-gemini-json-metadata` version1 and verify metadata bytes/SHA256 against the
final manifest, retaining all gaps. Failures before publication, including invalid input,
budget refusal and pre-publication kill, publish no consumable final manifest. After
the no-replace commit point, output remains committed even if status delivery fails or
the CLI is killed. A failed summary write retains exit2 and emits the fixed COMMITTED
warning when stderr is available; closed stderr cannot provide that warning. Exit codes
and stdout alone never replace final-manifest/hash validation. SIGKILL tests do not prove power-loss
durability. Pending files/rows alone never authorize consumption. Diagnostics use egress.
Synthetic verification: `bun test tests/metadata/gemini-json.test.ts tests/metadata/gemini-export.test.ts tests/metadata/gemini-output.test.ts tests/metadata/gemini-custody-cli.test.ts`.
Existing broader metadata resource-preflight adverse receipts remain NOT_GREEN.
