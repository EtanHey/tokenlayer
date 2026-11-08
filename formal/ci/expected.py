"""Trusted expected-integration manifest for the fixed formal lanes.

An operator (or a reviewed workflow step) authors it before any lane runs; it is never inferred
from lane outputs. It binds the current run identity, the selected tool digests and each lane's
repository-relative source/model/corpus/contract digests. The launcher checks it before dispatch
and the gate re-checks it, plus the current source bytes, before PASS. This is consistency between
a trusted operator, runner and gate; it is not authentication, fencing or hostile same-UID defence.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

SCHEMA = 'tokenlayer.formal-ci.expected.v1'
KEYS = {'schema', 'profile', 'run', 'tools', 'lanes'}
GITHUB_ENV = ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')
RUN_FORMS = {  # every field required, nonempty and well formed; null never means fresh
    'github': {'sha': r'[0-9a-f]{40}', 'run_id': r'[1-9][0-9]{0,19}', 'attempt': r'[1-9][0-9]{0,5}'},
    'local': {'nonce': r'[A-Za-z0-9][A-Za-z0-9._-]{7,63}'},
}
HEX64 = re.compile(r'[0-9a-f]{64}')


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def digest(manifest):
    """Canonical identity of the whole validated manifest, independent of where it is stored."""
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _run(run):
    kind = run.get('kind') if isinstance(run, dict) else None
    form = RUN_FORMS.get(kind) if isinstance(kind, str) else None
    require(form is not None and set(run) == {'kind', *form} and all(
        isinstance(run[k], str) and re.fullmatch(p, run[k]) for k, p in form.items()), 'EXPECTED_RUN_MALFORMED')
    env = {k: os.environ.get(k) for k in GITHUB_ENV}
    want = dict(zip(GITHUB_ENV, (run['sha'], run['run_id'], run['attempt']))) if run['kind'] == 'github' \
        else dict.fromkeys(GITHUB_ENV)  # a local identity is never presented inside a GitHub run
    require(env == want, 'ENV_RUN_MISMATCH')


def _canonical(rel):
    p = PurePosixPath(rel) if isinstance(rel, str) else None
    return p is not None and rel == p.as_posix() and not p.is_absolute() and '..' not in p.parts \
        and bool(p.parts) and '\\' not in rel


def load(path, profile, required):
    """required: lane -> repo-relative paths every manifest must bind. Returns (manifest, digest)."""
    try:
        m = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise RuntimeError('EXPECTED_MISSING') from None
    except (OSError, ValueError):
        raise RuntimeError('EXPECTED_SCHEMA') from None
    require(isinstance(m, dict) and m.get('schema') == SCHEMA, 'EXPECTED_SCHEMA')
    require(m.get('profile') == profile, 'EXPECTED_PROFILE')
    _run(m.get('run'))
    require(set(m) == KEYS, 'EXPECTED_SCHEMA')
    t = m['tools']
    require(isinstance(t, dict) and set(t) == {'java', 'jar', 'bun'}
            and all(isinstance(v, str) and HEX64.fullmatch(v) for v in t.values()), 'EXPECTED_TOOLS')
    lanes = m['lanes']
    require(isinstance(lanes, dict) and set(lanes) == set(required), 'EXPECTED_LANES')
    for name in sorted(required):
        entry = lanes[name]
        require(isinstance(entry, dict) and set(entry) == {'sources'} and isinstance(entry['sources'], dict),
                'EXPECTED_SCHEMA')
        for rel, h in sorted(entry['sources'].items()):
            require(_canonical(rel), 'EXPECTED_PATH:' + rel)
            require(isinstance(h, str) and HEX64.fullmatch(h), 'EXPECTED_SCHEMA')
        missing = sorted(set(required[name]) - set(entry['sources']))
        require(not missing, 'EXPECTED_SOURCES_INCOMPLETE:%s:%s' % (name, ','.join(missing)))
    return m, digest(m)


def current(root, rels):
    """Current bytes of repo-relative sources; None if absent, not a file or resolving outside root."""
    base, out = Path(root).resolve(strict=True), {}
    for rel in sorted(rels):
        try:
            p = (base / rel).resolve(strict=True)
            out[rel] = sha(p) if p.is_relative_to(base) and p.is_file() else None
        except OSError:
            out[rel] = None
    return out


def mismatched(root, sources):
    cur = current(root, sources)
    return sorted(k for k, h in sources.items() if cur[k] != h)
