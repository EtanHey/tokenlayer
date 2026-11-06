# Cursor project transcript JSONL reader — completed-code review pending

`projectCursorProjectJsonl(buffer)` projects caller-owned bytes; `readCursorProjectJsonl(path, pin)`
reads exactly one canonical, explicitly pinned regular file. Both return metadata in memory.
This slice adds no CLI, export controller, corpus scan, network, database, producer or output writes.
No actual corpus export is authorized before lead-routed completed-code review.

The observed supported envelope is `{role, message: {content: [...]}}`. Text, tool inputs,
tool names and arbitrary source property names are omitted. Content blocks retain their array index,
explicit type, IDs, clocks, scope and numeric usage fields when present. Unknown record envelopes
(including the sampled terminal records) remain `UNSUPPORTED_SHAPE`; unknown metadata locations
remain counted gaps. IDs are source-local recorded fields, never filename-derived identities.

Every occurrence retains its original physical source SHA256/bytes and LF record SHA256/bytes,
one-based line, zero-based UTF8 byte start/end-exclusive (including CR/LF), and termination flag.
Repeated IDs remain separate occurrences. All clocks stay independent; creation/update fields
are lifecycle metadata, event fields are unverified recorded candidates, numeric units UNKNOWN.
No account/client/model/provider is inferred. No clock validates a request or active work by itself.

Absent, null, stored zero, value and unresolved are distinct. Known numeric token components
retain their names; unfamiliar component names retain SHA256(name) plus their independent numeric
tree. Unknown strings, arrays, unsafe integers and excessive nesting remain unresolved. No
arithmetic, billing interpretation, deltas, inclusion assumptions, duration or deduplication occurs.
Noncanonical numeric lexemes (fraction, exponent, negative zero) conservatively mark all equal
decoded numbers within that LF record unresolved; no rounded value is accepted as a stored zero.
Unsafe metadata strings are unresolved rather than rewritten into a different ID. Body-bearing
objects are not descended into by metadata projection. Full-byte JSON validation still examines
the complete record, and numeric lexeme validation considers the complete record conservatively.

Ceilings: 16MiB/file, 1MiB/LF record, 10000 records, 256 content blocks/record, 16MiB serialized
record metadata, 2000ms cooperative deadline. Options may only lower limits. The reused bounded
JSON scanner rejects duplicate decoded keys and excessive depth/token counts. Oversize, invalid,
unsupported and unterminated records have explicit hash-bearing gaps. Whole-file/resource/pin
failure throws a fixed `CURSOR_*` error and returns no partial result. The deadline is cooperative,
not a process watchdog. Pins bind bytes, SHA256 and six exact stat strings via `geminiStatPin`;
canonical path/stat checks bracket descriptor reads and projection, with O_NOFOLLOW/O_NONBLOCK.
These checks do not establish historical origin or protect against arbitrary same-UID tampering.

Caller owns authorization and aggregate read budgets; the one-file library never authorizes another
read. This lane's private six-file shape-only sample ledger is separate from parser execution.
Source acceptance remains HOLD and complete=false even when every scoped record projects.
Future output integration must use the reviewed private filesystem/output utilities and its own
reviewed admission contract. Synthetic verification: `bun test tests/metadata/cursor-project-jsonl.test.ts`.
