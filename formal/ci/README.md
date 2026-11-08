# Bounded formal-tool acquisition component

`acquisition.py` is a dependency-injected POSIX helper. The resolver supplies the
lock, artifact pin, SHA verifier, refusal function, opener and official-URL check.
It does not install, extract, retry, repair or qualify a tool. Every success returns
`ACQUIRED_UNQUALIFIED` with `formal_lane_accepted=false`.

The main single Python thread with default SIGCHLD supervises a forked worker over
open/read/EOF/close and reaps it on timeout or cancellation. Scheduling, local I/O
and abrupt supervisor death are not hard-real-time or hostile-actor guarantees.
The parent exclusively opens the0600 partial and passes its descriptor. IPC uses
a parent-created0600 temporary inode, unlinked before fork, through its descriptor.
A bounded JSON record carries only7 allowed builtin exception types and one string
argument. Other exception types (including OSError subclasses) become a bounded
RuntimeError message; errno/structured arguments are not preserved. No pickle is
decoded. Caller cancellation still propagates after worker reaping.

Cache poison is refused without repair. Partials are retained. A path swap during
publication can leave a refused cache, and a post-publication deadline refusal can
leave a verified cache; these are explicit remaining constraints. No Linux/tool
qualification, protocol acceptance, runtime or native authority follows.

Owned regression check (use a NEW ignored fixture directory each invocation):
`python3 -I -B formal/ci/check_acquisition_ipc.py formal/ci/acquisition.py <new-fixture-directory>`
It uses fake bytes and real local forked workers; no network or tool download.

## Tool identity resolver (`tools.py`, `toolchain.json`)

`resolve_tools(local_lock, profile='local-reviewed', *, paths=None)` takes the protocol's
unchanged JSON lock **path**. It never downloads, searches `PATH`, edits a lock or substitutes
a tool on failure. `local-reviewed` runs only on Darwin, with defaults Homebrew Java,
`~/.cache/tla/tla2tools.jar` and `~/.bun/bin/bun`. Explicit `paths` must name exactly `java`,
`jar` and `bun`. The protocol lock's jar pin is always enforced. Its Java/Bun hash and version
pins are enforced whenever present. Java and Bun must be executable. Version probes run with
the Java option/classpath variables removed, a 5 s deadline, kill-and-reap on timeout or
cancellation, and 64 KiB output and file-size bounds. Tool bytes, resolved paths, the supplied
lock path and both lock files are rechecked before return.

`ci-linux-x64-v1` is a separate, explicit Linux/x86_64 tool profile. It is not equivalent to
the reviewed Mac binaries and does not accept any protocol. It needs explicit `paths` and a
committed `HOSTED_REVIEWED` qualification. The qualification is `null`, so the profile refuses
`UNQUALIFIED` before any probe. The pinned official TLC jar differs from the local protocol
jar pin. Every result reports `jar_provenance`: `protocol_lock_sha256`,
`selected_profile_sha256` and `protocol_pin_matched`. With `protocol_pin_matched: false`, the
caller cannot claim that the protocol's original jar pin passed. Each protocol's stricter
post-model source and tool checks remain authoritative. Every result keeps
`formal_lane_accepted: false`.

`acquire(cache, 'jar'|'jdk_archive', *, timeout_s=120)` is the explicit Linux-only entry to
`acquisition.py`, with official HTTPS hosts, no environment proxies, and a budget that can only
shorten the 120 s ceiling. The constraints above still apply.

D1 regression (fake files, probes and host; NEW ignored fixture directory each run):
`python3 -I -B formal/ci/check_resolver_provenance.py formal/ci/tools.py <new-fixture-directory>`

Still pending: shared resolver/transfer controls, launcher/workflow/protocol integration and
Linux hosted qualification. B2/B3 remain open.
