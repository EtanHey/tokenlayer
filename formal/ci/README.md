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
