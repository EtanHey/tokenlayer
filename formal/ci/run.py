#!/usr/bin/env python3
"""Fixed five-lane formal launcher: whole-lane runner commands only; no download, repair or reuse."""
import sys
if not sys.flags.isolated:
    raise SystemExit('PYTHON_ISOLATION_REQUIRED')
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import selectors
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# Reviewed identity of formal/ci/closure.json; changing lane coverage means changing this pin.
CLOSURE_SHA256 = '93df4b5489d98b50c5ccd17fb24fecf34732542c91e5d574edc7a3e3b15726c1'
def _load(name, path):
    # Check read-decider bytes before module execution, including computed top-level loaders.
    raw = (HERE / 'closure.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != CLOSURE_SHA256:
        raise RuntimeError('CLOSURE_IDENTITY')
    pins = json.loads(raw)['shared']['consumers']
    me, count = re.subn(rb"(?m)^CLOSURE_SHA256 = '[0-9a-f]{64}'$",
                       b"CLOSURE_SHA256 = '" + b'0' * 64 + b"'", Path(__file__).read_bytes())
    if count != 1 or hashlib.sha256(me).hexdigest() != pins['formal/ci/run.py']:
        raise RuntimeError('CLOSURE_BOOTSTRAP_STALE:formal/ci/run.py')
    rel = 'formal/ci/' + path.name
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != pins[rel]:
        raise RuntimeError('CLOSURE_BOOTSTRAP_STALE:' + rel)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Execute the verified buffer, bypassing the loader's unbound bytecode cache and second read.
    exec(compile(source, str(path), 'exec', dont_inherit=True), module.__dict__)
    return module

tools = _load('formal_ci_tools', HERE / 'tools.py')
expected = _load('formal_ci_expected', HERE / 'expected.py')  # trusted expected-integration manifest
closure = _load('formal_ci_closure', HERE / 'closure.py')  # reviewed mandatory source closure
require = tools.require
PROFILES = ('local-reviewed', 'ci-linux-x64-v1')
# lane: (runner, output flag, protocol lock or None = writer's in-runner JAR_SHA, wall s, results)
LANES = {
    'importer': ('formal/history/check.py', '--out', 'formal/history/toolchain.json', 900, 33),
    'rotation': ('formal/history-rotation/check.py', '--out', 'formal/history-rotation/toolchain.json', 900, 41),
    'writer': ('formal/writer-transfer/check.py', '--output', None, 900, 31),
    'backup': ('formal/backup-before-delete/check.py', '--evidence', 'formal/backup-before-delete/toolchain.json', 900, 45),
    # S2 has no lock and uses no TLC; Bun identity is joined below. 5 children x 30 s, 180 s lane.
    's2': ('formal/history-conformance/check.py', '--out', 'formal/history/toolchain.json', 180, 5),
}
S2_VARIANTS = ['checkpoint-first', 'ack-missing', 'acceptance-bypass', 'stop-recheck-removed', 'current']
ROTATION_SOURCE = ['source-mutant', 'source-missed-link', 'source-baseline']
JOINS = {}  # lane -> reviewed resolver join; empty until each protocol owner publishes one
LOG_CAP, ARTIFACT_CAP, POLL_S, SCAN_S, DRAIN_S = 4 * 1024 ** 2, 512 * 1024 ** 2, 0.2, 1.0, 1.0
ENV_KEEP = ('HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ')
SCOPE = 'MODEL+SAMPLED_CODE_RECEIPTS_ONLY; NOT_NATIVE; NOT_RUNTIME; NOT_BACKEND'
_CANCELLED = []

class Cancelled(BaseException):
    pass

def _cancel(signum, frame):
    if not _CANCELLED:  # a second signal during cleanup is ignored, never re-raised mid-reap
        _CANCELLED.append(signal.Signals(signum).name)
        raise Cancelled(_CANCELLED[0])

def resolve(lock, profile, paths):
    return tools.resolve_tools(lock, profile, paths=paths)

def subreaper():
    """Linux only: orphaned descendants reparent to this launcher so they can be killed and reaped."""
    if sys.platform != 'linux':
        return False
    import ctypes
    return ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER

def owned_children():
    """Direct children of this process only (never a process-table scan)."""
    if sys.platform != 'linux':
        return []
    return sorted({int(p) for t in Path('/proc/self/task').iterdir()
                   for p in (t / 'children').read_text().split()})

def _reap_orphan(pid):
    for call in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL),
                 lambda: os.waitpid(pid, 0)):
        with contextlib.suppress(ProcessLookupError, PermissionError, ChildProcessError):
            call()

def _limit():
    hard = resource.getrlimit(resource.RLIMIT_FSIZE)[1]
    cap = ARTIFACT_CAP if hard == resource.RLIM_INFINITY else min(ARTIFACT_CAP, hard)
    resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

def _bytes(root):
    return sum(os.lstat(os.path.join(d, f)).st_size for d, _, fs in os.walk(root) for f in fs)

def contract():
    """The pinned closure contract; it must cover each fixed lane's runner (a consumer) and lock."""
    c = closure.load(ROOT, CLOSURE_SHA256)
    require(set(c['lanes']) == set(LANES) and all(
        v[0] in c['lanes'][n]['consumers'] and (v[2] is None or v[2] in closure.roles(c, n))
        for n, v in LANES.items()), 'CLOSURE_SCHEMA')
    return c

def required():
    """Repo-relative sources every expected manifest must bind per lane: the whole reviewed closure."""
    return closure.required(contract())

def admit(path, profile):
    """Current trusted expectation and mandatory closure, before any directory, probe or dispatch."""
    c = contract()
    manifest = expected.load(path, profile, closure.required(c))  # omitting any closure member refuses
    closure.observe(ROOT, c)  # stale consumers or an unlisted dependency refuse
    return manifest

def _supervise(rec, argv, log_path, lane_dir, seconds, env):
    """Bounded log while writing; wall/artifact bounds; kill+reap the owned group on every exit."""
    rec.update(timed_out=False, log_overflow=False, artifact_overflow=False, pipe_held=False,
               orphans=[], log_bytes=0)
    started = next_scan = time.monotonic()
    exited = None
    p = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=_limit)
    rec['pid'] = p.pid
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ)
    try:
        with log_path.open('xb') as log:
            while True:
                for key, _ in sel.select(POLL_S):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        sel.unregister(key.fileobj)
                        continue
                    keep = chunk[:max(0, LOG_CAP - rec['log_bytes'])]
                    log.write(keep)
                    rec['log_bytes'] += len(keep)
                    rec['log_overflow'] |= len(keep) < len(chunk)
                if rec['log_overflow']:
                    break
                now = time.monotonic()
                if os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    if not sel.get_map():
                        break
                    exited = exited or now  # leader gone, yet a descendant still holds the log pipe
                    if now - exited > DRAIN_S:
                        rec['pipe_held'] = True
                        break
                if now - started >= seconds:
                    rec['timed_out'] = True
                    break
                if now >= next_scan:
                    next_scan = now + SCAN_S
                    if _bytes(lane_dir) > ARTIFACT_CAP:
                        rec['artifact_overflow'] = True
                        break
    finally:
        # Leader is unreaped (WNOWAIT), so its pid names only its own group; Darwin: EPERM if zombie-only.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(p.pid, signal.SIGKILL)
        rec['exit'] = p.wait()
        sel.close()
        p.stdout.close()
        rec['orphans'] = owned_children()
        for pid in rec['orphans']:
            _reap_orphan(pid)
        rec['seconds'] = round(time.monotonic() - started, 3)

def _single(text, pattern):
    found = re.findall(pattern, text, re.M)
    require(len(found) == 1, 'MARKER_COUNT:%d:%s' % (len(found), pattern))
    return found[0]

def _inside(path, base):
    path = Path(path).resolve(strict=True)
    require(path.is_relative_to(base.resolve(strict=True)), 'OUTPUT_OUTSIDE_LANE')
    return path

def _tlc_bounds(argvs):
    for argv in argvs:
        if 'tlc2.TLC' in argv:
            i = argv.index('-workers')
            require(argv[i + 1] == '1' and '-Xmx512m' in argv, 'TLC_BOUNDS')

def verify(name, out, log, tool, count):
    """Adapt each runner's own receipt; its model/oracle/classifier authority is unchanged."""
    sha = tool['sha256']
    if name in ('importer', 'rotation', 's2'):
        marker = r'^receipt=(/.+)$' if name != 's2' else r'^(/.+/receipt\.json)$'
        r = json.loads(_inside(_single(log, marker), out).read_text())
        res = r['results']
        names = [x.get('name', x.get('case')) for x in res]
        require(r.get('complete') is True and r.get('not_run') == [] and 'error' not in r, 'INCOMPLETE')
        require(len(res) == count and len(set(names)) == count
                and all(x.get('valid') is True for x in res), 'FULL_SUITE')
        if name == 's2':
            require(names == S2_VARIANTS, 'FULL_SUITE')
            require(r['tool']['bun'] == tool['bun'] and r['tool']['sha256'] == sha['bun'], 'RUNNER_TOOL_IDENTITY')
            return
        t = r.get('tool') or r.get('tools')
        require(t['java'] == tool['java'] and t['java_sha256'] == sha['java']
                and t['jar_sha256'] == sha['jar'], 'RUNNER_TOOL_IDENTITY')
        if name == 'importer':
            require(r.get('full_suite_complete') is True and r.get('selected_case') is None, 'FULL_SUITE')
        else:
            require(names == r['expected_cases'] + ROTATION_SOURCE, 'FULL_SUITE')
            require(t['bun'] == tool['bun'] and t['bun_sha256'] == sha['bun'], 'RUNNER_TOOL_IDENTITY')
        _tlc_bounds([x.get('argv', []) for x in res])
    elif name == 'writer':
        _single(log, r'^(MODEL_RECEIPTS_MATCHED;.*)$')
        res = json.loads(_inside(out / 'results.json', out).read_text())
        ident = json.loads(_inside(out / 'identity.json', out).read_text())
        require(len(res) == count and len({x['case'] for x in res}) == count
                and all(x.get('matched') is True for x in res), 'FULL_SUITE')
        require(ident['java'] == tool['java'] and ident['jar_sha256'] == sha['jar'], 'RUNNER_TOOL_IDENTITY')
        _tlc_bounds([x['command'] for x in res])
    else:
        run = _inside(_single(log, r'^EVIDENCE (/.+)$'), out)
        s = json.loads(_inside(run / 'summary.json', out).read_text())
        t = json.loads(_inside(run / 'tools.json', out).read_text())
        require(s['total'] == count and s['matched'] == count and len(s['results']) == count
                and len({x['name'] for x in s['results']}) == count
                and all(x.get('matched') is True for x in s['results']), 'FULL_SUITE')
        require(t['java'] == tool['java'] and t['java_sha256'] == sha['java']
                and t['jar_sha256'] == sha['jar'], 'RUNNER_TOOL_IDENTITY')
        _tlc_bounds([x['command'] for x in s['results']])

def _lock(runner, lock, lane_dir):
    if lock:
        return ROOT / lock
    found = re.findall(r'^JAR_SHA = "([0-9a-f]{64})"$', runner.read_text(), re.M)
    require(len(found) == 1, 'WRITER_JAR_PIN_SOURCE')
    derived = lane_dir / 'derived-lock.json'  # jar-only authority, exactly the writer's own pin
    derived.write_text(json.dumps({'jar_sha256': found[0]}) + '\n')
    return derived

def lane(name, profile, attempt, manifest, paths=None):
    (m, digest), (runner_rel, flag, lock_rel, seconds, count) = manifest, LANES[name]
    want = m['lanes'][name]['sources']
    runner, d = ROOT / runner_rel, attempt / ('lane-' + name)
    d.mkdir(mode=0o700)
    out, log = d / 'output', d / 'lane.log'
    rec = {'schema': 'tokenlayer.formal-ci.lane.v1', 'lane': name, 'profile': profile, 'status': 'REFUSED',
           'formal_lane_accepted': False, 'scope': SCOPE, 'launcher_sha256': tools.sha(Path(__file__)),
           'interpreter': sys.executable, 'interpreter_sha256': tools.sha(Path(sys.executable).resolve()),
           'run': m['run'], 'expected_sha256': digest, 'closure_sha256': CLOSURE_SHA256,
           'budget_s': seconds, 'log_cap': LOG_CAP, 'artifact_cap': ARTIFACT_CAP, 'expected_results': count}
    try:
        require(profile in PROFILES, 'UNKNOWN_PROFILE')
        require(paths is None or profile != 'local-reviewed', 'LOCAL_PATHS_FIXED')  # runners hardcode them
        rec['sources'] = expected.current(ROOT, want)  # repo-relative, portable across artifact paths
        bad = expected.mismatched(ROOT, want)
        require(not bad, 'SOURCE_MISMATCH:' + ','.join(bad))
        lock = _lock(runner, lock_rel, d)
        tool = rec['tool'] = resolve(lock, profile, paths)
        bad = [k for k in ('java', 'jar', 'bun') if tool['sha256'][k] != m['tools'][k]]
        require(not bad, 'EXPECTED_TOOL:' + ','.join(bad))
        require(profile == 'local-reviewed' or name in JOINS, 'PROTOCOL_JOIN_ABSENT')
        require(tool['jar_provenance']['protocol_pin_matched'] is True, 'PROTOCOL_JAR_PIN_UNMATCHED')
        require(Path(tool['bun']).name == 'bun', 'BUN_NAME')
        env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
        env['PATH'] = str(Path(tool['bun']).parent) + ':/usr/bin:/bin'  # S2 PATH lookup is verified below
        rec['argv'] = [sys.executable, '-I', '-B', str(runner), flag, str(out)]
        _supervise(rec, rec['argv'], log, d, seconds, env)
        rec['log_sha256'] = tools.sha(log)
        for key in ('timed_out', 'log_overflow', 'artifact_overflow', 'pipe_held', 'orphans'):
            require(not rec[key], key.upper())
        require(rec['exit'] == 0, 'EXIT:%d' % rec['exit'])
        require(expected.current(ROOT, want) == rec['sources'], 'PIN_DRIFT')
        require(all(tools.sha(tool[k]) == tool['sha256'][k] for k in ('java', 'jar', 'bun')), 'TOOL_DRIFT')
        verify(name, out, log.read_text(errors='replace'), tool, count)
        rec.update(status='MATCHED', formal_lane_accepted=True)
    except Cancelled as signal_name:
        rec.update(status='CANCELLED', error='CANCELLED:%s' % signal_name)
        raise
    except Exception as error:
        rec.update(status='FAILED' if 'argv' in rec else 'REFUSED', error='%s: %s' % (type(error).__name__, error))
    finally:
        rec['artifact_bytes_before_receipt'] = _bytes(d)
        payload = json.dumps(rec, indent=2) + '\n'
        if rec['artifact_bytes_before_receipt'] + len(payload.encode('utf-8')) > ARTIFACT_CAP:
            rec.update(artifact_overflow=True, formal_lane_accepted=False)
            if rec['status'] == 'MATCHED':
                rec.update(status='FAILED', error='ARTIFACT_OVERFLOW')
            payload = json.dumps(rec, indent=2) + '\n'
        (d / 'lane.json').write_text(payload, encoding='utf-8')
        print('lane=%s status=%s' % (d / 'lane.json', rec['status']), flush=True)
    return rec

def _each(recs, bad, code):
    names = [r['lane'] for r in recs if bad(r)]
    require(not names, code + ':' + ','.join(names))

def gate(profile, lane_dirs, out, expected_path):
    """All five fixed lanes once each, under the CURRENT trusted expectation and current sources."""
    result = {'schema': 'tokenlayer.formal-ci.gate.v1', 'profile': profile, 'lanes': None,
              'status': 'REFUSED', 'expected_sha256': None, 'scope': SCOPE}
    try:
        m, digest = admit(expected_path, profile)
        result['expected_sha256'] = digest
        recs = [json.loads((Path(p) / 'lane.json').read_text()) for p in lane_dirs]
        names = result['lanes'] = [r.get('lane') for r in recs]
        require(sorted(map(str, names)) == sorted(LANES), 'LANE_SET:' + ','.join(map(str, names)))
        me = tools.sha(Path(__file__))
        _each(recs, lambda r: not (r.get('profile') == profile and r.get('status') == 'MATCHED'
              and r.get('formal_lane_accepted') is True and r.get('launcher_sha256') == me), 'LANE_NOT_ACCEPTED')
        require(len({json.dumps(r.get('run'), sort_keys=True) for r in recs}) == 1, 'MIXED_RUNS')
        _each(recs, lambda r: r.get('run') != m['run'], 'RECEIPT_RUN')
        _each(recs, lambda r: (r.get('tool') or {}).get('sha256') != m['tools'], 'RECEIPT_TOOLS')
        _each(recs, lambda r: r.get('sources') != m['lanes'][r['lane']]['sources'], 'RECEIPT_SOURCES')
        _each(recs, lambda r: r.get('expected_sha256') != digest, 'RECEIPT_EXPECTED')
        _each(recs, lambda r: r.get('closure_sha256') != CLOSURE_SHA256, 'RECEIPT_CLOSURE')
        union = {k: v for n in sorted(LANES) for k, v in m['lanes'][n]['sources'].items()}
        bad = expected.mismatched(ROOT, union)  # relevant sources re-read now, not trusted from receipts
        require(not bad, 'SOURCE_MISMATCH:' + ','.join(bad))
        result['status'] = 'PASS'
    except Exception as error:
        result['error'] = str(error)
    with Path(out).open('x') as f:
        f.write(json.dumps(result, indent=2) + '\n')
    print('gate=%s status=%s' % (out, result['status']), flush=True)
    return result

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='command', required=True)
    for command in ('lane', 'all', 'gate'):
        p = sub.add_parser(command)
        p.add_argument('--profile', required=True, choices=PROFILES)
        p.add_argument('--out', required=True, type=Path, help='NEW attempt root (gate: NEW file)')
        p.add_argument('--expected', required=True, type=Path, help='trusted expected-integration manifest')
        if command == 'lane':
            p.add_argument('--lane', required=True, choices=sorted(LANES))
        if command == 'gate':
            p.add_argument('lane_dirs', nargs='+')
        else:
            p.add_argument('--tool-paths', type=Path, help='JSON {java,jar,bun}; explicit CI profile only')
    a = ap.parse_args(argv)
    if a.command == 'gate':
        return 0 if gate(a.profile, a.lane_dirs, a.out, a.expected)['status'] == 'PASS' else 1
    try:
        manifest = admit(a.expected, a.profile)  # before any directory, probe or runner dispatch
    except RuntimeError as error:
        print('expected=%s status=REFUSED error=%s' % (a.expected, error), flush=True)
        return 1
    paths = json.loads(a.tool_paths.read_text()) if a.tool_paths else None
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, _cancel)
    a.out.mkdir(mode=0o700)
    print('subreaper=%s' % subreaper(), flush=True)
    try:
        names = [a.lane] if a.command == 'lane' else list(LANES)
        recs = [lane(n, a.profile, a.out, manifest, paths) for n in names]  # sequential; matrix max-parallel 2
        if a.command == 'all':
            return 0 if gate(a.profile, [a.out / ('lane-' + n) for n in names],
                             a.out / 'gate.json', a.expected)['status'] == 'PASS' else 1
        return 0 if recs[0]['status'] == 'MATCHED' else 1
    except Cancelled:
        return 130

if __name__ == '__main__':
    raise SystemExit(main())
