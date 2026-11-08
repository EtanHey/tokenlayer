"""Reviewed mandatory source closure for the fixed five local formal lanes.

closure.json names every repository file each lane's actual runner consumes, by role: exec (run or
model-checked), input (read as data, config or lock) or identity (hashed, copied or retained only).
run.py pins the contract's SHA-256, so changing coverage is a reviewed launcher change. Bounded
deterministic rules refuse a stale contract instead of admitting a dependency it does not name:
  consumers  exact digests of all executable code and read-deciding data, including shared modules;
  dirs       directories a runner enumerates: every matching entry must be a member;
  imports    relative TypeScript import closure from the executed roots: every file must be exec;
  shared     a sibling file named by a literal in a shared launcher module must be a shared member.
The bounded scanner is an additional check, not authority to admit changed code. Every executable
read decider is pinned even when a loader expression is outside that scanner's grammar. Trusted-
operator consistency only: no authentication, sandboxing or runtime introspection.
"""
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

SCHEMA = 'tokenlayer.formal-ci.closure.v3'
NAME = 'formal/ci/closure.json'
ROLES = ('exec', 'input', 'identity')
LANE_KEYS = {'consumers', 'dirs', 'imports', *ROLES}
HEX64 = re.compile(r'[0-9a-f]{64}')
# static `from '...'`, side-effect `import '...'`, literal or non-literal import()/require()
SPEC = re.compile(r'''\b(?:from|import)\s*['"]([^'"\n]+)['"]'''
                  r'''|\b(?:import|require)\s*\(\s*(?:['"]([^'"\n]+)['"]\s*\)|([^\s'")][^)\n]*)\))''')
SIBLING = re.compile(r'''['"]([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:py|json))['"]''')
BUILTIN = ('node:', 'bun:')
CODE = ('.py', '.ts', '.tla')
BUN_INPUTS = {'formal/ci/bunfig.toml', 'formal/ci/tsconfig.json', 'package.json'}
LAUNCHER_PIN = re.compile(rb"(?m)^CLOSURE_SHA256 = '[0-9a-f]{64}'$")


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def _canonical(rel):
    p = PurePosixPath(rel) if isinstance(rel, str) else None
    return p is not None and rel == p.as_posix() and not p.is_absolute() and '..' not in p.parts \
        and bool(p.parts) and '\\' not in rel


def _paths(value):
    return isinstance(value, list) and all(_canonical(p) for p in value) and len(set(value)) == len(value)


def roles(c, lane=None):
    """path -> role for the shared members plus one lane's members (lane None: shared only)."""
    entries = [c['shared']] + ([c['lanes'][lane]] if lane else [])
    return {p: r for e in entries for r in ROLES for p in e.get(r, [])}


def required(c):
    return {lane: sorted(roles(c, lane)) for lane in sorted(c['lanes'])}


def package_paths(c):
    """Bun package metadata beside each executed TS file and on its ancestors inside the checkout."""
    found = {'package.json'}
    for e in c['lanes'].values():
        for rel in (p for p in e['exec'] if p.endswith('.ts')):
            parent = PurePosixPath(rel).parent
            while parent.parts:
                found.add(str(parent / 'package.json'))
                parent = parent.parent
    return found


def bun_shadow_paths(c):
    """The reviewed bindings use .ts files only; reject competing Bun resolution candidates."""
    return sorted({str(PurePosixPath(p).with_suffix('')) + ext
                   for e in c['lanes'].values() for p in e['exec'] if p.endswith('.ts')
                   for ext in ('', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json')})


def load(root, pin):
    """The pinned contract, schema-checked. Refuses CLOSURE_MISSING/CLOSURE_IDENTITY/CLOSURE_SCHEMA."""
    try:
        data = (Path(root) / NAME).read_bytes()
    except FileNotFoundError:
        raise RuntimeError('CLOSURE_MISSING') from None
    require(hashlib.sha256(data).hexdigest() == pin, 'CLOSURE_IDENTITY')
    try:
        c = json.loads(data)
    except ValueError:
        raise RuntimeError('CLOSURE_SCHEMA') from None
    ok = isinstance(c, dict) and set(c) == {'schema', 'shared', 'lanes'} and c['schema'] == SCHEMA \
        and isinstance(c['shared'], dict) and set(c['shared']) == {*ROLES, 'consumers', 'absent'} \
        and all(_paths(c['shared'][r]) for r in ROLES) and isinstance(c['shared']['consumers'], dict) \
        and _paths(c['shared']['absent']) \
        and isinstance(c['lanes'], dict) and c['lanes']
    require(ok, 'CLOSURE_SCHEMA')
    shared = roles(c)
    require({p for p in shared if p.endswith(CODE)} <= set(c['shared']['consumers']) and all(
        p in shared and isinstance(h, str) and HEX64.fullmatch(h) for p, h in c['shared']['consumers'].items())
        and BUN_INPUTS <= set(c['shared']['consumers'])
        and BUN_INPUTS <= set(c['shared']['input'])
        and not set(c['shared']['absent']) & set(shared), 'CLOSURE_SCHEMA')
    for lane, e in c['lanes'].items():
        require(isinstance(e, dict) and set(e) == LANE_KEYS and all(_paths(e[r]) for r in ROLES)
                and _paths(e['imports']) and isinstance(e['consumers'], dict) and e['consumers']
                and isinstance(e['dirs'], dict), 'CLOSURE_SCHEMA')
        listed = [p for r in ROLES for p in e[r]] + [p for r in ROLES for p in c['shared'].get(r, [])]
        member = roles(c, lane)
        require(len(listed) == len(member)  # one role per path
                and all(p in member and isinstance(h, str) and HEX64.fullmatch(h) for p, h in e['consumers'].items())
                and {p for p in e['exec'] if p.endswith(CODE)} <= set(e['consumers'])
                and all(member.get(p) == 'exec' for p in e['imports'])
                and all(_canonical(d) and isinstance(g, str) and g for d, g in e['dirs'].items()), 'CLOSURE_SCHEMA')
    require(package_paths(c) <= set(c['shared']['consumers']) | set(c['shared']['absent']), 'CLOSURE_SCHEMA')
    return c


def _file(base, rel):
    """Resolved regular file inside base, else None (absent, special, or a link leaving the root)."""
    try:
        p = (base / rel).resolve(strict=True)
    except OSError:
        return None
    return p if p.is_relative_to(base) and p.is_file() else None


def _digest(base, rel):
    p = _file(base, rel)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p else None


def consumer_digest(base, rel):
    """Pin all bytes; only the launcher's one contract-hash value is zeroed to avoid a digest cycle."""
    p = _file(base, rel)
    if p is None:
        return None
    data = p.read_bytes()
    if rel == 'formal/ci/run.py':
        if len(LAUNCHER_PIN.findall(data)) != 1:
            return None
        data = LAUNCHER_PIN.sub(b"CLOSURE_SHA256 = '" + b'0' * 64 + b"'", data)
    return hashlib.sha256(data).hexdigest()


def _resolve(base, rel, spec):
    if spec.startswith(BUILTIN):
        return None
    require(spec.startswith('.'), 'CLOSURE_PACKAGE:%s:%s' % (rel, spec))
    target = os.path.normpath(str(PurePosixPath(rel).parent / (spec if spec.endswith('.ts') else spec + '.ts')))
    require(_canonical(target) and _file(base, target) is not None, 'CLOSURE_UNRESOLVED:%s:%s' % (rel, spec))
    return target


def _imports(base, roots, consumers):
    """Deterministic relative import closure; returns (files, files with unpinned dynamic imports)."""
    seen, todo, dynamic = set(), list(roots), set()
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        seen.add(rel)
        p = _file(base, rel)
        require(p is not None, 'CLOSURE_UNRESOLVED:%s' % rel)
        for m in SPEC.finditer(p.read_text(encoding='utf-8', errors='replace')):
            if m.group(3) is not None:
                if rel not in consumers:
                    dynamic.add(rel)
                continue
            target = _resolve(base, rel, m.group(1) or m.group(2))
            if target:
                todo.append(target)
    return seen, dynamic


def observe(root, c):
    """Refuse when current consumers or the observed dependency graph exceed the reviewed contract."""
    base = Path(root).resolve(strict=True)
    stale = sorted('%s:%s' % (lane, p) for lane, e in sorted(c['lanes'].items())
                   for p, h in sorted(e['consumers'].items()) if consumer_digest(base, p) != h)
    stale += ['shared:' + p for p, h in sorted(c['shared']['consumers'].items())
              if consumer_digest(base, p) != h]
    require(not stale, 'CLOSURE_CONSUMER_STALE:' + ','.join(stale))
    present = sorted(p for p in set(c['shared']['absent']) | set(bun_shadow_paths(c))
                     if os.path.lexists(base / p))
    require(not present, 'CLOSURE_AMBIENT_INPUT:' + ','.join(present))
    extra, dynamic = set(), set()
    for lane, e in sorted(c['lanes'].items()):
        member = roles(c, lane)
        for d, pattern in sorted(e['dirs'].items()):
            try:
                names = os.listdir(base / d)
            except OSError:
                names = None
            require(names is not None, 'CLOSURE_UNRESOLVED:%s' % d)
            extra |= {(lane, d + '/' + n) for n in names
                      if fnmatch.fnmatchcase(n, pattern) and d + '/' + n not in member}
        seen, found = _imports(base, e['imports'], e['consumers'])
        extra |= {(lane, p) for p in seen if member.get(p) != 'exec'}
        dynamic |= {(lane, p) for p in found}
    for rel in sorted(p for p in roles(c) if p.endswith('.py')):
        p = _file(base, rel)
        text = p.read_text(encoding='utf-8', errors='replace') if p else ''
        siblings = {str(PurePosixPath(rel).parent / n) for n in SIBLING.findall(text)}
        extra |= {('shared', s) for s in siblings if _file(base, s) and s not in roles(c)}
    require(not dynamic, 'CLOSURE_DYNAMIC:' + ','.join('%s:%s' % x for x in sorted(dynamic)))
    require(not extra, 'CLOSURE_STALE:' + ','.join('%s:%s' % x for x in sorted(extra)))
