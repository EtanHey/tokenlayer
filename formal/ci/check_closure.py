"""Mandatory source-closure controls on the REAL lane closure; owned fake runners/tools only.
Usage: python3 -I -B check_closure.py <formal/ci module dir> <source root> <NEW fixture dir>
<source root> holds every file named by its formal/ci/closure.json (a checkout, or members materialized
from exact Git objects). Real runners are never executed: each is replaced by an owned fake that reads
its lane's mandatory members, and the three TLC locks name the fake tools. No Java/Bun/TLC/version/network
step. Every control compares its whole observed string exactly with its expectation."""
import contextlib, copy, hashlib, importlib.util, io, json, os, re, shutil, sys, time
from pathlib import Path

MOD, SRC, F = (Path(a).resolve() for a in sys.argv[1:4])
F.mkdir(mode=0o700, exist_ok=False)
REPO, TOOLS = F / 'repo', F / 'tools'
TOOLS.mkdir()
ROLES = ('exec', 'input', 'identity')
REAL = json.loads((SRC / 'formal/ci/closure.json').read_text())
members = lambda c, lane: sorted({p for e in (c['shared'], c['lanes'][lane]) for r in ROLES for p in e.get(r, [])})
ALL = sorted({p for lane in REAL['lanes'] for p in members(REAL, lane)})
for rel in ALL:
    (REPO / rel).parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(SRC / rel, REPO / rel)
MODULE = [n for n in ('run.py', 'tools.py', 'expected.py', 'closure.py', 'toolchain.json') if (MOD / n).exists()]
for n in MODULE:
    shutil.copyfile(MOD / n, REPO / 'formal/ci' / n)
for key in ('java', 'jar', 'bun'):
    (TOOLS / key).write_bytes(b'fake-' + key.encode()); (TOOLS / key).chmod(0o700)
GH = ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')
for k in GH:
    os.environ.pop(k, None)
SPAWNS = []
def audit(event, args):  # only this interpreter may start; any socket use fails the control run
    if event == 'subprocess.Popen':
        exe = args[0] if args[0] is not None else list(args[1])[0]
        if Path(exe).resolve() != Path(sys.executable).resolve():
            raise RuntimeError('REAL_TOOL_FORBIDDEN:%s' % exe)
        SPAWNS.append(list(map(str, args[1])))
    if event.startswith('socket.') or event == 'urllib.Request':
        raise RuntimeError('NETWORK_FORBIDDEN:' + event)
sys.addaudithook(audit)
def sha(p):
    p = Path(p)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else '0' * 64
PATHS = {k: str((TOOLS / k).resolve()) for k in ('java', 'jar', 'bun')}
TOOL = {**PATHS, **{k + '_sha256': sha(v) for k, v in PATHS.items()}}
DIRS = {'importer': 'history', 'rotation': 'history-rotation', 'writer': 'writer-transfer',
        'backup': 'backup-before-delete', 's2': 'history-conformance'}
FAKE = '''import hashlib, json, shutil, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent; ROOT = HERE.parents[1]
B = json.loads((ROOT / 'behavior.json').read_text()); lane, t = B['dirs'][HERE.name], B['tool']
JAR_SHA = "%s"
consumed = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in B['reads'][lane]}  # causal reads
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=lane != 'writer'); run = out / 'run-1'; run.mkdir()
(out / 'consumed.json').write_text(json.dumps(consumed))
argv = [t['java'], '-Xmx512m', '-cp', t['jar'], 'tlc2.TLC', '-workers', '1']
java = dict(java=t['java'], java_sha256=t['java_sha256'], jar_sha256=t['jar_sha256'])
if lane == 'importer':
    r = dict(complete=True, full_suite_complete=True, selected_case=None, not_run=[], tool=java,
             results=[dict(name='c%%d' %% i, valid=True, argv=argv) for i in range(33)])
elif lane == 'rotation':
    cases = ['c%%d' %% i for i in range(38)]
    r = dict(complete=True, not_run=[], expected_cases=cases, tools=dict(java, bun=t['bun'], bun_sha256=t['bun_sha256']),
             results=[dict(case=c, valid=True, argv=argv) for c in cases + ['source-mutant', 'source-missed-link', 'source-baseline']])
elif lane == 's2':
    names = ['checkpoint-first', 'ack-missing', 'acceptance-bypass', 'stop-recheck-removed', 'current']
    r = dict(complete=True, not_run=[], results=[dict(name=n, valid=True) for n in names],
             tool=dict(bun=str(Path(shutil.which('bun')).resolve()), sha256=t['bun_sha256']))
if lane in ('importer', 'rotation', 's2'):
    (run / 'receipt.json').write_text(json.dumps(r)); print(('' if lane == 's2' else 'receipt=') + str(run / 'receipt.json'))
elif lane == 'writer':
    run.rmdir(); (out / 'results.json').write_text(json.dumps([dict(case='c%%d' %% i, matched=True, command=argv) for i in range(31)]))
    (out / 'identity.json').write_text(json.dumps(dict(java=t['java'], jar_sha256=t['jar_sha256']))); print('MODEL_RECEIPTS_MATCHED; fake')
else:
    rows = [dict(name='c%%d' %% i, matched=True, command=argv) for i in range(45)]
    (run / 'summary.json').write_text(json.dumps(dict(total=45, matched=45, results=rows)))
    (run / 'tools.json').write_text(json.dumps(java)); print('EVIDENCE ' + str(run))
''' % TOOL['jar_sha256']
lock = {'jar_sha256': TOOL['jar_sha256'], 'java_version': 'fake java\n'}
for lane, d in DIRS.items():  # owned fakes replace exactly the five runners and three TLC locks
    (REPO / 'formal' / d / 'check.py').write_text(FAKE)
    if lane in ('importer', 'rotation', 'backup'):
        (REPO / 'formal' / d / 'toolchain.json').write_text(json.dumps({**lock, **({'java_sha256': TOOL['java_sha256']} if lane == 'backup' else {})}))
FIX = copy.deepcopy(REAL)  # the real contract with only the five runner consumer pins re-pinned to the fakes
for lane, d in DIRS.items():
    FIX['lanes'][lane]['consumers']['formal/%s/check.py' % d] = sha(REPO / 'formal' / d / 'check.py')
CONTRACT = REPO / 'formal/ci/closure.json'
CONTRACT.write_text(json.dumps(FIX, indent=1))
fixture_run = REPO / 'formal/ci/run.py'
fixture_run.write_text(re.sub(r"(?m)^CLOSURE_SHA256 = '[0-9a-f]{64}'$",
    "CLOSURE_SHA256 = '" + sha(CONTRACT) + "'", fixture_run.read_text()))
PIN = re.search(r"^CLOSURE_SHA256 = '([0-9a-f]{64})'$", (MOD / 'run.py').read_text(), re.M)
spec = importlib.util.spec_from_file_location('run', REPO / 'formal/ci/run.py')
run = importlib.util.module_from_spec(spec); spec.loader.exec_module(run)
run.CLOSURE_SHA256 = sha(CONTRACT)
probes = []
def probe(path, flag):
    probes.append(str(path))
    return {'exit': 0, 'stdout': 'fake bun\n' if flag == '--version' else '',
            'stderr': 'fake java\n' if flag == '-version' else '', 'timed_out': False}
run.tools._probe = probe
real_resolve = run.tools.resolve_tools
run.resolve = lambda lock, profile, paths: real_resolve(lock, profile, paths=paths or PATHS)
TREES = ('formal', 'scripts', 'src', 'schema', 'tests')
frozen = lambda: {str(p): sha(p) for t in TREES for p in sorted((REPO / t).rglob('*')) if p.is_file()}
(REPO / 'behavior.json').write_text(json.dumps({'tool': TOOL, 'dirs': {v: k for k, v in DIRS.items()},
                                                'reads': {k: members(REAL, k) for k in DIRS}}))
INPUTS, results, n, m_n = frozen(), [], [0], [0]
LOCAL = {'kind': 'local', 'nonce': 'closure-attempt-0001'}
def manifest(sources=None, edit=None):
    """Operator-authored: hashes CURRENT fixture sources (the full closure by default), never lane output."""
    sources = sources or {k: members(REAL, k) for k in DIRS}
    m = {'schema': 'tokenlayer.formal-ci.expected.v1', 'profile': 'local-reviewed', 'run': dict(LOCAL),
         'tools': {k: TOOL[k + '_sha256'] for k in ('java', 'jar', 'bun')},
         'lanes': {k: {'sources': {r: sha(REPO / r) for r in sources[k]}} for k in DIRS}}
    if edit:
        edit(m)
    m_n[0] += 1; p = F / ('expected-%d.json' % m_n[0]); p.write_text(json.dumps(m, indent=1)); return p
OLD_SHARED = ['formal/ci/run.py', 'formal/ci/tools.py', 'formal/ci/expected.py', 'formal/ci/toolchain.json']
MINIMUM = {k: sorted({v[0], *([v[2]] if v[2] else []), *OLD_SHARED}) for k, v in run.LANES.items()}  # R2's legal minimum
def attempt():
    n[0] += 1
    return F / ('attempt-%d' % n[0])
def check(case, expect, fn):
    t0 = time.monotonic()
    try:
        observed = fn()
    except SystemExit as e:
        observed = 'SystemExit:%s' % e.code
    except Exception as e:
        observed = 'UNEXPECTED %s: %s' % (type(e).__name__, e)
    results.append(dict(case=case, expected=expect, observed=str(observed), matched=str(observed) == expect,
                        wall_s=round(time.monotonic() - t0, 3)))
def launch(argv):
    """Exit, refusal reason (or final status), whether the attempt root exists, owned starts and probes."""
    s0, p0, out, buf = len(SPAWNS), len(probes), attempt(), io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = run.main([*argv, '--out', str(out)])
    last = buf.getvalue().strip().splitlines()[-1]
    why = last.rpartition(' error=')[2] if ' error=' in last else 'status=' + last.rpartition('status=')[2]
    return 'exit=%d %s out=%s dispatch=%d probes=%d' % (code, why, out.exists(), len(SPAWNS) - s0, len(probes) - p0)
def lane(name, expected):
    return launch(['lane', '--profile', 'local-reviewed', '--lane', name, '--expected', str(expected)])
def gate(dirs, expected):
    out = attempt()
    code = run.main(['gate', '--profile', 'local-reviewed', '--expected', str(expected), '--out', str(out), *map(str, dirs)])
    g = json.loads(out.read_text())
    return '%d %s %s' % (code, g['status'], g.get('error'))
@contextlib.contextmanager
def changed(edits):
    """Temporarily replace (bytes), append (('+', bytes)) or delete (None) fixture files; always restored."""
    saved = {rel: (REPO / rel).read_bytes() if (REPO / rel).exists() else None for rel in edits}
    try:
        for rel, new in edits.items():
            p = REPO / rel
            if new is None:
                p.unlink()
            else:
                p.write_bytes(saved[rel] + new[1] if isinstance(new, tuple) else new)
        yield
    finally:
        for rel, old in saved.items():
            (REPO / rel).unlink(missing_ok=True)
            if old is not None:
                (REPO / rel).write_bytes(old)
FIVE = 'importer,rotation,writer,backup,s2'
REFUSE = lambda why: 'exit=1 %s out=False dispatch=0 probes=0' % why
# 1. The real contract is the pinned one, and it matches the real lane files without any fake.
check('real-contract-pinned', 'True', lambda: str(bool(PIN) and PIN.group(1) == sha(SRC / 'formal/ci/closure.json')))
def real_tree():
    if not (MOD / 'closure.py').exists():
        return 'NO_CLOSURE_MODULE'
    s = importlib.util.spec_from_file_location('real_closure', MOD / 'closure.py')
    c = importlib.util.module_from_spec(s); s.loader.exec_module(c)
    c.observe(SRC, c.load(SRC, PIN.group(1)))
    return 'OK %d members' % len(ALL)
check('real-tree-closure-observed', 'OK %d members' % len(ALL), real_tree)
check('fixture-differs-only-in-runner-pins', 'True', lambda: str(
    [(k, p) for k in DIRS for p, h in FIX['lanes'][k]['consumers'].items() if REAL['lanes'][k]['consumers'][p] != h]
    == [(k, 'formal/%s/check.py' % d) for k, d in DIRS.items()] and {k: FIX['lanes'][k] | {'consumers': 0} for k in DIRS}
    == {k: REAL['lanes'][k] | {'consumers': 0} for k in DIRS} and FIX['shared'] == REAL['shared']))
# 2. R2's legal minimum manifest: the old runtime admits it (and PASSes stale sets); the closure refuses it.
BACKUP_MISSING = ('EXPECTED_SOURCES_INCOMPLETE:backup:formal/backup-before-delete/BackupBeforeDelete.tla,'
                  'formal/backup-before-delete/Hold.cfg,formal/backup-before-delete/Permitted.cfg,'
                  'formal/backup-before-delete/README.md,formal/ci/acquisition.py,formal/ci/bunfig.toml,'
                  'formal/ci/closure.json,formal/ci/closure.py,formal/ci/tsconfig.json,package.json')
MIN = manifest(MINIMUM)
check('minimum-manifest-all', REFUSE(BACKUP_MISSING), lambda: launch(['all', '--profile', 'local-reviewed', '--expected', str(MIN)]))
MIN_SET = [F / ('attempt-%d' % n[0]) / ('lane-' + k) for k in DIRS]
OMIT = [('importer', 'formal/history/Importer.tla', 'importer-model'), ('importer', 'formal/history/checks.json', 'importer-config'),
        ('importer', 'scripts/history/stream.ts', 'importer-sampled-source'), ('rotation', 'formal/history-rotation/Rotation.tla', 'rotation-model'),
        ('rotation', 'formal/history-rotation/conformance.ts', 'rotation-adapter'), ('rotation', 'src/lib/row-size.ts', 'rotation-transitive-source'),
        ('rotation', 'tests/integration/history-revision.it.test.ts', 'rotation-anchor'), ('writer', 'formal/writer-transfer/Transfer.tla', 'writer-model'),
        ('writer', 'formal/writer-transfer/ProposedStop.cfg', 'writer-baseline-config'), ('writer', 'scripts/history/README.md', 'writer-source-identity'),
        ('backup', 'formal/backup-before-delete/Hold.cfg', 'backup-config'), ('s2', 'formal/history-conformance/corpus.json', 's2-corpus'),
        ('s2', 'formal/history-conformance/contract.json', 's2-contract'), ('s2', 'formal/history-conformance/bind.ts', 's2-adapter'),
        ('s2', 'formal/history/Importer.tla', 's2-canonical-model'), ('s2', 'src/ship/zst.ts', 's2-transitive-source'),
        ('s2', 'schema/004_session_events.sql', 's2-schema'), ('s2', 'tests/integration/history.it.test.ts', 's2-anchor'),
        ('s2', 'formal/ci/closure.json', 'shared-contract')]
for name, rel, label in OMIT:
    check('omit-' + label, REFUSE('EXPECTED_SOURCES_INCOMPLETE:%s:%s' % (name, rel)),
          lambda name=name, rel=rel: lane(name, manifest(edit=lambda m: m['lanes'][name]['sources'].pop(rel))))
# 3. Full mandatory closure through the real launcher APIs; each fake read exactly the bound bytes.
M = manifest()
def positive():
    out = attempt()
    code = run.main(['all', '--profile', 'local-reviewed', '--expected', str(M), '--out', str(out)])
    g, bound = json.loads((out / 'gate.json').read_text()), json.loads(M.read_text())['lanes']
    recs = [json.loads((out / ('lane-' + k) / 'lane.json').read_text()) for k in DIRS]
    consumed = all(json.loads((out / ('lane-' + k) / 'output/consumed.json').read_text()) == bound[k]['sources'] for k in DIRS)
    pinned = all(r['closure_sha256'] == run.CLOSURE_SHA256 and r['sources'] == bound[r['lane']]['sources'] for r in recs)
    return '%s exit=%d %s consumed=%s pinned=%s' % (g['status'], code, [r['status'] for r in recs], consumed, pinned)
check('full-closure-all-five', "PASS exit=0 ['MATCHED', 'MATCHED', 'MATCHED', 'MATCHED', 'MATCHED'] consumed=True pinned=True", positive)
GOOD = [F / ('attempt-%d' % n[0]) / ('lane-' + k) for k in DIRS]
check('full-closure-gate', '0 PASS None', lambda: gate(GOOD, M))
def downloaded():
    dirs = [F / 'download' / ('formal-local-' + d.name) / d.name for d in GOOD]
    for d, t in zip(GOOD, dirs):
        shutil.copytree(d, t)
    return gate(dirs, M)
check('full-closure-gate-artifact-download', '0 PASS None', downloaded)
check('full-closure-lane-api', 'exit=0 status=MATCHED out=True dispatch=1 probes=2', lambda: lane('s2', M))  # java+bun
# 4. Stale sets: the old runtime PASSes a minimum-manifest set after an omitted dependency changes.
for rel in ('formal/history/Importer.tla', 'formal/history/checks.json', 'formal/history-conformance/corpus.json',
            'formal/history-conformance/contract.json', 'formal/history-conformance/bind.ts', 'scripts/history/stream.ts',
            'src/ship/zst.ts', 'formal/writer-transfer/Transfer.tla', 'formal/backup-before-delete/Hold.cfg'):
    def stale(rel=rel):
        with changed({rel: ('+', b'\n')}):
            return gate(MIN_SET if (MIN_SET[0] / 'lane.json').exists() else GOOD, MIN)
    check('stale-minimum-set-after:' + rel, '1 REFUSED ' + BACKUP_MISSING, stale)
# 5. Every mandatory member changed after a complete full-closure set refuses at the gate.
CONSUMERS = {}
for p in FIX['shared']['consumers']:
    CONSUMERS.setdefault(p, []).append('shared')
for k in DIRS:
    for p in FIX['lanes'][k]['consumers']:
        CONSUMERS.setdefault(p, []).append(k)
def drift_expect(rel):
    if rel == 'formal/ci/closure.json':
        return '1 REFUSED CLOSURE_IDENTITY'
    if rel in CONSUMERS:
        return '1 REFUSED CLOSURE_CONSUMER_STALE:' + ','.join('%s:%s' % (k, rel) for k in sorted(CONSUMERS[rel]))
    return '1 REFUSED SOURCE_MISMATCH:' + rel
for rel in ALL:
    def drift(rel=rel):
        with changed({rel: ('+', b'\n')}):
            return gate(GOOD, M)
    check('drift-after-lane:' + rel, drift_expect(rel), drift)
# 6. Absent/stale/omitted/corrupt contract and graph or membership additions refuse before any start.
def admitted(edits, name='importer', pin=None):
    saved = run.CLOSURE_SHA256
    with changed(edits):
        run.CLOSURE_SHA256 = pin(saved) if pin else saved
        try:
            return lane(name, manifest())  # re-authored from current bytes: only the closure can refuse
        finally:
            run.CLOSURE_SHA256 = saved
def contract_without(lane_name, role, rel):
    c = copy.deepcopy(FIX); c['lanes'][lane_name][role].remove(rel); return json.dumps(c, indent=1).encode()
CORRUPT = b'{"schema": "tokenlayer.formal-ci.closure.v1", "shared": '
SCHEMA_EDIT = copy.deepcopy(FIX)
SCHEMA_EDIT['lanes']['importer']['consumers'] = {'formal/history/Importer.tla': sha(REPO / 'formal/history/Importer.tla')}
SCHEMA_EDIT = json.dumps(SCHEMA_EDIT).encode()
STREAM, HASH = 'scripts/history/stream.ts', 'src/lib/hash.ts'
for case, expect, edits, pin, name in [
        ('contract-absent', 'CLOSURE_MISSING', {'formal/ci/closure.json': None}, None, 'importer'),
        ('contract-member-omitted', 'CLOSURE_IDENTITY', {'formal/ci/closure.json': contract_without('importer', 'exec', 'formal/history/Importer.tla')}, None, 'importer'),
        ('contract-corrupt', 'CLOSURE_IDENTITY', {'formal/ci/closure.json': CORRUPT}, None, 'importer'),
        ('contract-corrupt-repinned', 'CLOSURE_SCHEMA', {'formal/ci/closure.json': CORRUPT}, lambda s: hashlib.sha256(CORRUPT).hexdigest(), 'importer'),
        ('contract-runner-unpinned-repinned', 'CLOSURE_SCHEMA', {'formal/ci/closure.json': SCHEMA_EDIT},
         lambda s: hashlib.sha256(SCHEMA_EDIT).hexdigest(), 'importer'),
        ('consumer-stale-runner', 'CLOSURE_CONSUMER_STALE:importer:formal/history/check.py', {'formal/history/check.py': ('+', b'# edit\n')}, None, 'importer'),
        ('consumer-stale-rotation-adapter', 'CLOSURE_CONSUMER_STALE:rotation:formal/history-rotation/conformance.ts',
         {'formal/history-rotation/conformance.ts': ('+', b'// edit\n')}, None, 'rotation'),
        ('consumer-stale-s2-adapter', 'CLOSURE_CONSUMER_STALE:s2:formal/history-conformance/bind.ts',
         {'formal/history-conformance/bind.ts': ('+', b'// edit\n')}, None, 's2'),
        ('consumer-stale-s2-corpus', 'CLOSURE_CONSUMER_STALE:s2:formal/history-conformance/corpus.json',
         {'formal/history-conformance/corpus.json': ('+', b'\n')}, None, 's2'),
        ('dir-added-writer', 'CLOSURE_STALE:writer:formal/writer-transfer/Extra.cfg', {'formal/writer-transfer/Extra.cfg': b'x\n'}, None, 'writer'),
        ('dir-added-rotation', 'CLOSURE_STALE:rotation:formal/history-rotation/notes.txt', {'formal/history-rotation/notes.txt': b'x\n'}, None, 'rotation'),
        ('dir-added-backup', 'CLOSURE_STALE:backup:formal/backup-before-delete/Extra.tla', {'formal/backup-before-delete/Extra.tla': b'x\n'}, None, 'backup'),
        ('import-added', 'CLOSURE_CONSUMER_STALE:rotation:scripts/history/stream.ts,s2:scripts/history/stream.ts',
         {STREAM: ('+', b"import { added } from './added';\n"), 'scripts/history/added.ts': b'export const added = 1;\n'}, None, 's2'),
        ('import-role-identity-to-exec', 'CLOSURE_CONSUMER_STALE:rotation:scripts/history/stream.ts,s2:scripts/history/stream.ts',
         {STREAM: ('+', b"import '../../src/ship/state';\n")}, None, 'rotation'),
        ('import-unresolved', 'CLOSURE_CONSUMER_STALE:rotation:scripts/history/stream.ts,s2:scripts/history/stream.ts', {STREAM: ('+', b"import { x } from './missing';\n")}, None, 's2'),
        ('import-package', 'CLOSURE_CONSUMER_STALE:rotation:scripts/history/stream.ts,s2:scripts/history/stream.ts', {STREAM: ('+', b"import pad from 'left-pad';\n")}, None, 's2'),
        ('import-dynamic', 'CLOSURE_CONSUMER_STALE:rotation:src/lib/hash.ts,s2:src/lib/hash.ts', {HASH: ('+', b"await import(process.env.X!);\n")}, None, 's2'),
        ('shared-sibling-added', 'CLOSURE_CONSUMER_STALE:shared:formal/ci/tools.py',
         {'formal/ci/helper.py': b'x = 1\n', 'formal/ci/tools.py': ('+', b"# _load('helper.py')\n")}, None, 'importer')]:
    check(case, REFUSE(expect), lambda edits=edits, pin=pin, name=name: admitted(edits, name, pin))
check('dir-rule-matches-runner-glob', 'exit=0 status=MATCHED out=True dispatch=1 probes=2',
      lambda: admitted({'formal/history-rotation/NOTES': b'x\n'}, 'rotation'))  # rotation globs '*.*' only
for rel in FIX['shared']['absent']:
    check('ambient-package-added:' + rel, REFUSE('CLOSURE_AMBIENT_INPUT:' + rel),
          lambda rel=rel: admitted({rel: b'{"type":"module"}\n'}))
for rel in ('formal/ci/bunfig.toml', 'formal/ci/tsconfig.json', 'package.json'):
    check('ambient-config-reexpected:' + rel, REFUSE('CLOSURE_CONSUMER_STALE:shared:' + rel),
          lambda rel=rel: admitted({rel: ('+', b'\n')}))
check('bun-tsx-shadow-added', REFUSE('CLOSURE_AMBIENT_INPUT:src/lib/hash.tsx'),
      lambda: admitted({'src/lib/hash.tsx': b'export const shadow = true;\n'}))
for ext in ('mts', 'cts'):
    rel = 'src/lib/hash.' + ext
    check('bun-' + ext + '-shadow-added', REFUSE('CLOSURE_AMBIENT_INPUT:' + rel),
          lambda rel=rel: admitted({rel: b'export const shadow = true;\n'}))
def gate_after(edits):
    with changed(edits):
        return gate(GOOD, M)
check('gate-import-added-after-lane', '1 REFUSED CLOSURE_CONSUMER_STALE:rotation:scripts/history/stream.ts,s2:scripts/history/stream.ts',
      lambda: gate_after({STREAM: ('+', b"import { added } from './added';\n"), 'scripts/history/added.ts': b'export const added = 1;\n'}))
check('gate-dir-added-after-lane', '1 REFUSED CLOSURE_STALE:writer:formal/writer-transfer/Extra.cfg',
      lambda: gate_after({'formal/writer-transfer/Extra.cfg': b'x\n'}))
check('gate-mts-added-after-lane', '1 REFUSED CLOSURE_AMBIENT_INPUT:src/lib/hash.mts',
      lambda: gate_after({'src/lib/hash.mts': b'export const shadow = true;\n'}))
check('gate-package-added-after-lane', '1 REFUSED CLOSURE_AMBIENT_INPUT:src/lib/package.json',
      lambda: gate_after({'src/lib/package.json': b'{"type":"module"}\n'}))
def other_contract():
    dirs = []
    for d in GOOD:
        t = F / 'other-contract' / d.name; t.mkdir(parents=True); r = json.loads((d / 'lane.json').read_text())
        r['closure_sha256'] = '3' * 64; (t / 'lane.json').write_text(json.dumps(r)); dirs.append(t)
    return gate(dirs, M)
check('gate-receipt-other-contract', '1 REFUSED RECEIPT_CLOSURE:' + FIVE, other_contract)
check('inputs-unchanged', 'True', lambda: str(frozen() == INPUTS))
check('probes-fake-only', 'True', lambda: str(bool(probes) and all(p.startswith(str(TOOLS)) for p in probes)))
check('starts-python-only', 'True', lambda: str(bool(SPAWNS) and all(a[0] == sys.executable for a in SPAWNS)))
(F / 'results.json').write_text(json.dumps(dict(results=results, spawns=len(SPAWNS), probes=len(probes),
                                                members=len(ALL)), indent=2) + '\n')
for r in results:
    print(('ok   ' if r['matched'] else 'FAIL ') + r['case'] + ': ' + r['observed'])
print('%d/%d matched' % (sum(r['matched'] for r in results), len(results)))
raise SystemExit(0 if all(r['matched'] for r in results) else 1)
