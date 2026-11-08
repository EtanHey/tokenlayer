"""Offline launcher controls: owned fake runners/tools only; no Java/Bun/TLC/version/network step.
Usage: python3 -I -B check_run.py <dir with run.py,tools.py,expected.py,toolchain.json> <NEW fixture dir>
Every control compares its whole observed string exactly with its expectation."""
import contextlib, copy, hashlib, importlib.util, io, json, os, shutil, signal, sys, threading, time
from pathlib import Path

MOD, F = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
F.mkdir(mode=0o700, parents=True, exist_ok=False)
REPO, TOOLS = F / 'repo', F / 'tools'
(REPO / 'formal/ci').mkdir(parents=True); TOOLS.mkdir()
for name in ('run.py', 'tools.py', 'expected.py', 'toolchain.json'):
    shutil.copyfile(MOD / name, REPO / 'formal/ci' / name)
for key in ('java', 'jar', 'bun'):
    (TOOLS / key).write_bytes(b'fake-' + key.encode()); (TOOLS / key).chmod(0o700)
GH = ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')
ENV_AT_START = {k: k in os.environ for k in GH}
for k in GH:
    os.environ.pop(k, None)  # every control sets the run environment it needs explicitly
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
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
PATHS = {k: str((TOOLS / k).resolve()) for k in ('java', 'jar', 'bun')}
TOOL = {**PATHS, **{k + '_sha256': sha(v) for k, v in PATHS.items()}}
DIRS = {'importer': 'history', 'rotation': 'history-rotation', 'writer': 'writer-transfer',
        'backup': 'backup-before-delete', 's2': 'history-conformance'}
FAKE = '''import json, os, shutil, subprocess, sys, time
from pathlib import Path
HERE = Path(__file__).resolve().parent; ROOT = HERE.parents[1]
B = json.loads((ROOT / 'behavior.json').read_text()); lane = B['dirs'][HERE.name]
mode, t, out = B['modes'].get(lane, 'ok'), B['tool'], Path(sys.argv[2])
(ROOT / ('started-' + lane)).write_text(str(os.getpid()))
JAR_SHA = "%s"
if mode in ('sleep', 'orphan', 'held'):
    quiet = subprocess.DEVNULL if mode == 'orphan' else None  # 'held' keeps the lane log pipe open
    kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], start_new_session=mode != 'sleep', stdout=quiet, stderr=quiet)
    (ROOT / ('kid-' + lane)).write_text(str(kid.pid))
    if mode == 'sleep': time.sleep(120)
if mode == 'flood': sys.stdout.write('x' * (1 << 20)); sys.stdout.flush(); time.sleep(120)
if mode == 'bulk':
    out.mkdir(parents=True)
    for i in range(4): (out / str(i)).write_bytes(bytes(1 << 19))
    time.sleep(120)
if mode == 'burst':  # wait for the launcher's first live byte scan, then write 8 x 16 KiB and exit
    deadline = time.monotonic() + 3
    while not (ROOT / 'first-byte-scan').exists():
        if time.monotonic() >= deadline: raise SystemExit('HANDSHAKE_TIMEOUT')
        time.sleep(0.001)
    out.mkdir(parents=True)
    for i in range(8): (out / ('bulk-%%d' %% i)).write_bytes(bytes(16384))
if mode == 'mutate-lock':
    with open(HERE / 'toolchain.json', 'a') as f: f.write(' ')
argv = lambda: [t['java'], '-Xmx512m', '-cp', t['jar'], 'tlc2.TLC', '-workers', '2' if mode == 'workers' else '1']
ok = lambda i: not (mode == 'wrong' and i == 0)
jar = '0' * 64 if mode == 'tool' else t['jar_sha256']
out.mkdir(parents=True, exist_ok=lane != 'writer'); run = out / 'run-1'; run.mkdir(exist_ok=True)
where = ROOT if mode == 'escape' else run
if lane == 'importer':
    r = dict(complete=True, full_suite_complete=True, selected_case=None, not_run=['x'] if mode == 'wrong' else [],
             results=[dict(name='c%%d' %% i, valid=True, argv=argv()) for i in range(33)],
             tool=dict(java=t['java'], java_sha256=t['java_sha256'], jar_sha256=jar))
elif lane == 'rotation':
    cases = ['c%%d' %% i for i in range(38)]
    r = dict(complete=True, not_run=[], expected_cases=cases, tools=dict(java=t['java'], java_sha256=t['java_sha256'],
             jar_sha256=jar, bun=t['bun'], bun_sha256=t['bun_sha256']),
             results=[dict(case=c, valid=ok(i), argv=argv()) for i, c in enumerate(cases + ['source-mutant', 'source-missed-link', 'source-baseline'])])
elif lane == 's2':
    bun = str(Path(shutil.which('bun')).resolve())
    names = ['checkpoint-first', 'ack-missing', 'acceptance-bypass', 'stop-recheck-removed', 'current']
    r = dict(complete=True, not_run=[], results=[dict(name=n, valid=ok(i)) for i, n in enumerate(names)],
             tool=dict(bun=bun, sha256=t['bun_sha256']))
if lane in ('importer', 'rotation', 's2'):
    (where / 'receipt.json').write_text(json.dumps(r))
    print(('' if lane == 's2' else 'receipt=') + str(where / 'receipt.json'))
elif lane == 'writer':
    run.rmdir()
    rows = json.dumps([dict(case='c%%d' %% i, matched=ok(i), command=argv()) for i in range(31)])
    if mode == 'symlink':  # parseable results outside the lane, reached through a leaf link
        (ROOT / 'outside-results.json').write_text(rows); (out / 'results.json').symlink_to(ROOT / 'outside-results.json')
    else:
        (out / 'results.json').write_text(rows)
    (out / 'identity.json').write_text(json.dumps(dict(java=t['java'], jar_sha256=jar)))
    for _ in range(2 if mode == 'dup' else 0 if mode == 'nomarker' else 1): print('MODEL_RECEIPTS_MATCHED; fake')
else:
    rows = [dict(name='c%%d' %% i, matched=ok(i), command=argv()) for i in range(45)]
    (run / 'summary.json').write_text(json.dumps(dict(total=45, matched=sum(x['matched'] for x in rows), results=rows)))
    (run / 'tools.json').write_text(json.dumps(dict(java=t['java'], java_sha256=t['java_sha256'], jar_sha256=jar)))
    print('EVIDENCE ' + str(run))
if mode == 'dup' and lane == 'importer': print('receipt=' + str(run / 'receipt.json'))
raise SystemExit(1 if mode == 'exit1' else 0)
''' % TOOL['jar_sha256']
lock = {'jar_sha256': TOOL['jar_sha256'], 'java_version': 'fake java\n'}
for lane, d in DIRS.items():
    (REPO / 'formal' / d).mkdir(exist_ok=True)
    (REPO / 'formal' / d / 'check.py').write_text(FAKE)
    if lane in ('importer', 'rotation', 'backup'):
        extra = {'java_sha256': TOOL['java_sha256']} if lane == 'backup' else {}
        (REPO / 'formal' / d / 'toolchain.json').write_text(json.dumps({**lock, **extra}))
# Model/corpus/contract sources an operator chooses to bind beyond each lane's required minimum.
EXTRA = {'importer': ['formal/history/Model.tla'], 'rotation': ['formal/history-rotation/Rotation.tla'],
         'writer': ['formal/writer-transfer/Writer.tla'], 'backup': ['formal/backup-before-delete/Backup.tla'],
         's2': ['formal/history-conformance/contract.json', 'formal/history-conformance/corpus/case-1.json']}
for rel in sum(EXTRA.values(), []):
    (REPO / rel).parent.mkdir(parents=True, exist_ok=True); (REPO / rel).write_text('fake source ' + rel + '\n')
spec = importlib.util.spec_from_file_location('run', REPO / 'formal/ci/run.py')
run = importlib.util.module_from_spec(spec); spec.loader.exec_module(run)
probes = []
def probe(path, flag):
    probes.append(str(path))
    return {'exit': 0, 'stdout': 'fake bun\n' if flag == '--version' else '',
            'stderr': 'fake java\n' if flag == '-version' else '', 'timed_out': False}
run.tools._probe = probe
real_resolve = run.tools.resolve_tools
run.resolve = lambda lock, profile, paths: real_resolve(lock, profile, paths=paths or PATHS)
frozen = lambda: {str(p): sha(p) for root in (REPO / 'formal', TOOLS) for p in sorted(root.rglob('*')) if p.is_file()}
INPUTS, results, n, m_n = frozen(), [], [0], [0]
LOCAL = {'kind': 'local', 'nonce': 'local-attempt-0001'}
GHA = {'kind': 'github', 'sha': 'a' * 40, 'run_id': '111', 'attempt': '1'}
def manifest(profile='local-reviewed', run_id=LOCAL, edit=None):
    """Operator-authored synthetic expectation: hashes the fixture SOURCES, never any lane output."""
    m = {'schema': 'tokenlayer.formal-ci.expected.v1', 'profile': profile, 'run': copy.deepcopy(run_id),
         'tools': {k: TOOL[k + '_sha256'] for k in ('java', 'jar', 'bun')},
         'lanes': {k: {'sources': {r: sha(REPO / r) for r in run.required()[k] + EXTRA[k]}} for k in DIRS}}
    if edit:
        edit(m)
    m_n[0] += 1; p = F / ('expected-%d.json' % m_n[0]); p.write_text(json.dumps(m, indent=1)); return p
def setenv(r):
    for k in GH:
        os.environ.pop(k, None)
    if r['kind'] == 'github':
        os.environ.update(zip(GH, (r['sha'], r['run_id'], r['attempt'])))
M0 = manifest()
def behave(**modes):
    (REPO / 'behavior.json').write_text(json.dumps({'modes': modes, 'tool': TOOL, 'dirs': {v: k for k, v in DIRS.items()}}))
def attempt():
    n[0] += 1
    return F / ('attempt-%d' % n[0])
def lane_rec(name, profile='local-reviewed', extra=(), expected=None, **modes):
    behave(**modes); out = attempt()
    code = run.main(['lane', '--profile', profile, '--expected', str(expected or M0), '--out', str(out), '--lane', name, *extra])
    rec = json.loads((out / ('lane-' + name) / 'lane.json').read_text())
    return code, rec
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
def status(name, **modes):
    code, rec = lane_rec(name, **modes)
    return '%s exit=%d %s' % (rec['status'], code, rec.get('error', ''))
def dead(pid_file):
    pid = int(pid_file.read_text())
    for _ in range(50):
        try:
            os.kill(pid, 0); time.sleep(0.1)
        except ProcessLookupError:
            return 'reaped'
    os.kill(pid, signal.SIGKILL); return 'ALIVE'
def refused(argv):
    """Pre-dispatch refusal: exit, printed reason, whether the attempt root exists, owned starts."""
    before, out, buf = len(SPAWNS), attempt(), io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = run.main([*argv, '--out', str(out)])
    last = buf.getvalue().strip().splitlines()[-1]
    return 'exit=%d %s out=%s dispatch=%d' % (code, last.rpartition(' error=')[2], out.exists(), len(SPAWNS) - before)
def positive(expected=None):
    behave(); out = attempt()
    code = run.main(['all', '--profile', 'local-reviewed', '--expected', str(expected or M0), '--out', str(out)])
    gate = json.loads((out / 'gate.json').read_text())
    return '%s exit=%d %s' % (gate['status'], code, [json.loads((out / ('lane-' + k) / 'lane.json').read_text())['status'] for k in DIRS])
ALL5 = "PASS exit=0 ['MATCHED', 'MATCHED', 'MATCHED', 'MATCHED', 'MATCHED']"
check('all-five-positive', ALL5, positive)
GOOD = F / ('attempt-%d' % n[0])
lanes = [GOOD / ('lane-' + k) for k in DIRS]
LANE = ['lane', '--profile', 'local-reviewed', '--lane', 'importer', '--expected']
for case, argv in [('unknown-profile', ['lane', '--profile', 'bogus', '--lane', 'importer', '--expected', str(M0)]),
                   ('diagnostic-case', [*LANE, str(M0), '--case', 'x']),
                   ('arbitrary-lane', ['lane', '--profile', 'local-reviewed', '--lane', 'bogus', '--expected', str(M0)]),
                   ('expected-argument-absent', ['lane', '--profile', 'local-reviewed', '--lane', 'importer'])]:
    check(case, 'SystemExit:2', lambda argv=argv: run.main([*argv, '--out', str(attempt())]))
check('expected-file-missing', 'exit=1 EXPECTED_MISSING out=False dispatch=0', lambda: refused([*LANE, str(F / 'absent.json')]))
NO_RUN = lambda m: m.pop('run')
NULL_RUN = lambda m: m.update(run={'kind': 'github', 'sha': None, 'run_id': None, 'attempt': None})
for case, edit in [('expected-run-absent', NO_RUN), ('expected-run-null', NULL_RUN),
                   ('expected-run-short-sha', lambda m: m['run'].update(kind='github', sha='abc', run_id='1', attempt='1') or m['run'].pop('nonce')),
                   ('expected-local-nonce-empty', lambda m: m['run'].update(nonce='')),
                   ('expected-run-kind-unhashable', lambda m: m['run'].update(kind=['local']))]:
    check(case, 'exit=1 EXPECTED_RUN_MALFORMED out=False dispatch=0', lambda edit=edit: refused([*LANE, str(manifest(edit=edit))]))
def env_case(run_id, env):
    p = manifest(run_id=run_id); setenv(env)
    try:
        return refused([*LANE, str(p)])
    finally:
        setenv(LOCAL)
check('github-run-env-absent', 'exit=1 ENV_RUN_MISMATCH out=False dispatch=0', lambda: env_case(GHA, LOCAL))
check('github-run-env-other-attempt', 'exit=1 ENV_RUN_MISMATCH out=False dispatch=0', lambda: env_case(GHA, {**GHA, 'attempt': '2'}))
check('local-nonce-inside-github-env', 'exit=1 ENV_RUN_MISMATCH out=False dispatch=0', lambda: env_case(LOCAL, GHA))
check('expected-unknown-key', 'exit=1 EXPECTED_SCHEMA out=False dispatch=0', lambda: refused([*LANE, str(manifest(edit=lambda m: m.update(skip=['s2'])))]))
check('expected-profile-other', 'exit=1 EXPECTED_PROFILE out=False dispatch=0', lambda: refused([*LANE, str(manifest('ci-linux-x64-v1'))]))
check('expected-lane-sources-incomplete', 'exit=1 EXPECTED_SOURCES_INCOMPLETE:importer:formal/history/check.py out=False dispatch=0',
      lambda: refused([*LANE, str(manifest(edit=lambda m: m['lanes']['importer']['sources'].pop('formal/history/check.py')))]))
check('expected-path-escape', 'exit=1 EXPECTED_PATH:../outside out=False dispatch=0',
      lambda: refused([*LANE, str(manifest(edit=lambda m: m['lanes']['importer']['sources'].update({'../outside': 'f' * 64})))]))
def lane_refusal(expected, name='importer'):
    before = len(SPAWNS); code, rec = lane_rec(name, expected=expected)
    return '%s exit=%d %s dispatch=%d' % (rec['status'], code, rec.get('error'), len(SPAWNS) - before)
check('lane-source-mismatch-before-launch', 'REFUSED exit=1 RuntimeError: SOURCE_MISMATCH:formal/history/Model.tla dispatch=0',
      lambda: lane_refusal(manifest(edit=lambda m: m['lanes']['importer']['sources'].update({'formal/history/Model.tla': '0' * 64}))))
check('lane-expected-tool-mismatch', 'REFUSED exit=1 RuntimeError: EXPECTED_TOOL:jar dispatch=0',
      lambda: lane_refusal(manifest(edit=lambda m: m['tools'].update(jar='0' * 64))))
CI_M = manifest('ci-linux-x64-v1')
def null_qualification():
    host, run.tools._host, before = run.tools._host, lambda: ('Linux', 'x86_64'), len(probes)
    (F / 'paths.json').write_text(json.dumps(PATHS))
    try:
        code, rec = lane_rec('importer', 'ci-linux-x64-v1', ['--tool-paths', str(F / 'paths.json')], CI_M)
    finally:
        run.tools._host = host
    started = (REPO / 'started-importer').exists()
    return '%s %s started=%s probes=%d' % (rec['status'], rec['error'], started, len(probes) - before)
(REPO / 'started-importer').unlink(missing_ok=True)
check('null-qualification', 'REFUSED RuntimeError: UNQUALIFIED started=False probes=0', null_qualification)
check('local-explicit-paths', 'RuntimeError: LOCAL_PATHS_FIXED', lambda: lane_rec('importer', extra=['--tool-paths', str(F / 'paths.json')])[1]['error'])
def future_qualified(joins):  # simulated HOSTED_REVIEWED resolver result whose jar differs from the protocol pin
    saved, run.JOINS = (run.resolve, run.JOINS), joins
    run.resolve = lambda lock, profile, paths: {**real_resolve(lock, 'local-reviewed', paths=PATHS),
        'profile': profile, 'jar_provenance': {'protocol_pin_matched': False}}
    try:
        return lane_rec('importer', 'ci-linux-x64-v1', ['--tool-paths', str(F / 'paths.json')], CI_M)[1]['error']
    finally:
        run.resolve, run.JOINS = saved
check('ci-join-absent', 'RuntimeError: PROTOCOL_JOIN_ABSENT', lambda: future_qualified({}))
check('ci-jar-provenance-unmatched', 'RuntimeError: PROTOCOL_JAR_PIN_UNMATCHED', lambda: future_qualified({'importer': 'reviewed'}))
def gate(dirs, expected=None):
    out = attempt()
    code = run.main(['gate', '--profile', 'local-reviewed', '--expected', str(expected or M0), '--out', str(out), *map(str, dirs)])
    g = json.loads(out.read_text())
    return '%d %s %s' % (code, g['status'], g.get('error'))
FIVE = 'importer,rotation,writer,backup,s2'
check('gate-same-manifest-positive', '0 PASS None', lambda: gate(lanes))
def downloaded():  # artifact download moves every lane directory; repo-relative identities still join
    dirs = []
    for d in lanes:
        dirs.append(F / 'download' / ('formal-local-' + d.name) / d.name); shutil.copytree(d, dirs[-1])
    return gate(dirs)
check('gate-artifact-download-path', '0 PASS None', downloaded)
check('gate-missing-lane', '1 REFUSED LANE_SET:importer,rotation,writer,backup', lambda: gate(lanes[:4]))
check('gate-duplicate-lane', '1 REFUSED LANE_SET:importer,rotation,writer,backup,importer', lambda: gate(lanes[:4] + lanes[:1]))
check('gate-wrong-profile', 'SystemExit:2', lambda: run.main(['gate', '--profile', 'x', '--expected', str(M0), '--out', str(attempt()), *map(str, lanes)]))
check('gate-expected-missing', '1 REFUSED EXPECTED_MISSING', lambda: gate(lanes, F / 'absent.json'))
def mixed():
    lane_rec('s2', expected=manifest(run_id={'kind': 'local', 'nonce': 'local-attempt-0002'}))
    return gate(lanes[:4] + [F / ('attempt-%d' % n[0]) / 'lane-s2'])
check('gate-mixed-runs', '1 REFUSED MIXED_RUNS', mixed)
check('gate-failed-lane', '1 REFUSED LANE_NOT_ACCEPTED:importer', lambda: (lane_rec('importer', importer='exit1'),
      gate([F / ('attempt-%d' % n[0]) / 'lane-importer'] + lanes[1:]))[1])
check('gate-old-set-new-local-nonce', '1 REFUSED RECEIPT_RUN:' + FIVE,
      lambda: gate(lanes, manifest(run_id={'kind': 'local', 'nonce': 'local-attempt-0003'})))
def receipts(label, edit):  # copied receipts whose identity shape alone is changed
    dirs = []
    for d in lanes:
        t = F / label / d.name; t.mkdir(parents=True); r = json.loads((d / 'lane.json').read_text())
        edit(r); (t / 'lane.json').write_text(json.dumps(r)); dirs.append(t)
    return dirs
check('gate-receipt-run-removed', '1 REFUSED RECEIPT_RUN:' + FIVE, lambda: gate(receipts('run-removed', lambda r: r.pop('run'))))
check('gate-receipt-run-null', '1 REFUSED RECEIPT_RUN:' + FIVE, lambda: gate(receipts('run-null', lambda r: r.update(run=None))))
# One full GitHub-identity set, then the same old set under each changed current tuple.
G = manifest(run_id=GHA); setenv(GHA)
check('github-same-run-positive', ALL5, lambda: positive(G))
G_LANES = [F / ('attempt-%d' % n[0]) / ('lane-' + k) for k in DIRS]
def github_gate(new, dirs=None):
    setenv(new)
    try:
        return gate(dirs or G_LANES, manifest(run_id=new))
    finally:
        setenv(LOCAL)
for case, new in [('github-old-set-new-run', {**GHA, 'sha': 'b' * 40, 'run_id': '222', 'attempt': '2'}),
                  ('github-old-set-other-sha', {**GHA, 'sha': 'c' * 40}), ('github-old-set-other-run', {**GHA, 'run_id': '333'}),
                  ('github-old-set-other-attempt', {**GHA, 'attempt': '2'})]:
    check(case, '1 REFUSED RECEIPT_RUN:' + FIVE, lambda new=new: github_gate(new))
def gate_env_moved():
    setenv({**GHA, 'attempt': '3'})
    try:
        return gate(G_LANES, G)
    finally:
        setenv(LOCAL)
check('github-gate-env-other-attempt', '1 REFUSED ENV_RUN_MISMATCH', gate_env_moved)
def drift(rel):  # bound source changes after every lane completed; the manifest is unchanged
    p = REPO / rel; before = p.read_bytes(); p.write_bytes(before + b'\n# changed after lane\n')
    try:
        return gate(lanes)
    finally:
        p.write_bytes(before)
for case, rel in [('gate-runner-drift-after-lane', 'formal/history/check.py'),
                  ('gate-model-drift-after-lane', 'formal/history/Model.tla'),
                  ('gate-corpus-drift-after-lane', 'formal/history-conformance/corpus/case-1.json'),
                  ('gate-contract-drift-after-lane', 'formal/history-conformance/contract.json'),
                  ('gate-protocol-lock-drift-after-lane', 'formal/history/toolchain.json'),
                  ('gate-profile-authority-drift-after-lane', 'formal/ci/toolchain.json'),
                  ('gate-manifest-helper-drift-after-lane', 'formal/ci/expected.py')]:
    check(case, '1 REFUSED SOURCE_MISMATCH:' + rel, lambda rel=rel: drift(rel))
check('gate-reexpected-model-old-receipts', '1 REFUSED RECEIPT_SOURCES:importer',
      lambda: gate(lanes, manifest(edit=lambda m: m['lanes']['importer']['sources'].update({'formal/history/Model.tla': '1' * 64}))))
check('gate-selected-tool-expectation-changed', '1 REFUSED RECEIPT_TOOLS:' + FIVE,
      lambda: gate(lanes, manifest(edit=lambda m: m['tools'].update(jar='2' * 64))))
check('nonzero-exit', 'FAILED exit=1 RuntimeError: EXIT:1', lambda: status('importer', importer='exit1'))
check('importer-diagnostic-partial', 'FAILED exit=1 RuntimeError: INCOMPLETE', lambda: status('importer', importer='wrong'))
check('importer-duplicate-receipt', 'FAILED exit=1 RuntimeError: MARKER_COUNT:2:^receipt=(/.+)$', lambda: status('importer', importer='dup'))
check('importer-escaped-receipt', 'FAILED exit=1 RuntimeError: OUTPUT_OUTSIDE_LANE', lambda: status('importer', importer='escape'))
check('importer-tool-identity', 'FAILED exit=1 RuntimeError: RUNNER_TOOL_IDENTITY', lambda: status('importer', importer='tool'))
check('rotation-invalid-result', 'FAILED exit=1 RuntimeError: FULL_SUITE', lambda: status('rotation', rotation='wrong'))
check('rotation-tlc-workers', 'FAILED exit=1 RuntimeError: TLC_BOUNDS', lambda: status('rotation', rotation='workers'))
check('writer-missing-marker', 'FAILED exit=1 RuntimeError: MARKER_COUNT:0:^(MODEL_RECEIPTS_MATCHED;.*)$', lambda: status('writer', writer='nomarker'))
check('writer-duplicate-marker', 'FAILED exit=1 RuntimeError: MARKER_COUNT:2:^(MODEL_RECEIPTS_MATCHED;.*)$', lambda: status('writer', writer='dup'))
check('writer-unmatched-case', 'FAILED exit=1 RuntimeError: FULL_SUITE', lambda: status('writer', writer='wrong'))
check('writer-leaf-symlink-outside', 'FAILED exit=1 RuntimeError: OUTPUT_OUTSIDE_LANE', lambda: status('writer', writer='symlink'))
check('backup-partial-match', 'FAILED exit=1 RuntimeError: FULL_SUITE', lambda: status('backup', backup='wrong'))
check('s2-invalid-variant', 'FAILED exit=1 RuntimeError: FULL_SUITE', lambda: status('s2', s2='wrong'))
check('pin-drift', 'FAILED exit=1 RuntimeError: PIN_DRIFT', lambda: (status('rotation', rotation='mutate-lock'),
      (REPO / 'formal/history-rotation/toolchain.json').write_text(json.dumps(lock)))[0])
WAITS = {}
def bounded(case, expect, name, mode, **patch):
    saved = {k: getattr(run, k) for k in patch}
    for k, v in patch.items():
        setattr(run, k, v)
    try:
        code, rec = lane_rec(name, **{name: mode})
    finally:
        for k, v in saved.items():
            setattr(run, k, v)
    log = F / ('attempt-%d' % n[0]) / ('lane-' + name) / 'lane.log'
    kid = REPO / ('kid-' + name)
    extra = ' kid=' + dead(kid) if kid.exists() else ''
    if kid.exists():
        kid.unlink()
    WAITS[case] = rec.get('seconds')
    check(case, expect, lambda: '%s %s%s log=%d' % (rec['status'], rec.get('error'), extra, log.stat().st_size))
lanes_fast = {**run.LANES, 'importer': run.LANES['importer'][:3] + (1.5, 33)}
bounded('timeout-kill-reap', 'FAILED RuntimeError: TIMED_OUT kid=reaped log=0', 'importer', 'sleep', LANES=lanes_fast)
bounded('log-bounded-while-writing', 'FAILED RuntimeError: LOG_OVERFLOW log=65536', 'importer', 'flood',
        LANES=lanes_fast, LOG_CAP=65536)
bounded('artifact-bounded', 'FAILED RuntimeError: ARTIFACT_OVERFLOW log=0', 'backup', 'bulk', ARTIFACT_CAP=1 << 20,
        LANES={**run.LANES, 'backup': run.LANES['backup'][:3] + (10, 45)})
for mode, expect in (('orphan', 'ORPHANS kid=reaped log=29'), ('held', 'PIPE_HELD kid=reaped log=29')):  # Linux subreaper view faked
    bounded('descendant-' + mode, 'FAILED RuntimeError: ' + expect, 'writer', mode,
            owned_children=lambda: [int((REPO / 'kid-writer').read_text())])
def final_burst():  # R1 M2: writes land after the first live scan and the runner exits before the next one
    real, scans, cap = run._bytes, [], run.ARTIFACT_CAP
    def handshake(path):
        value = real(path); scans.append(value); (REPO / 'first-byte-scan').write_text('scanned'); return value
    run._bytes, run.ARTIFACT_CAP = handshake, 65536
    try:
        code, rec = lane_rec('importer', importer='burst')
    finally:
        run._bytes, run.ARTIFACT_CAP = real, cap; (REPO / 'first-byte-scan').unlink(missing_ok=True)
    d = F / ('attempt-%d' % n[0]) / 'lane-importer'
    WAITS['artifact-final-burst'] = dict(seconds=rec.get('seconds'), scans=scans, final_bytes=real(d))
    return '%s exit=%d %s overflow=%s accepted=%s runner_exit=%s live_scans=%d over_cap=%s' % (
        rec['status'], code, rec.get('error'), rec['artifact_overflow'], rec['formal_lane_accepted'], rec['exit'],
        len(scans) - 1, real(d) > 65536)
check('artifact-final-burst', 'FAILED exit=1 ARTIFACT_OVERFLOW overflow=True accepted=False runner_exit=0 live_scans=1 over_cap=True', final_burst)
def cancel():
    saved = run.LANES
    run.LANES = {**saved, 'rotation': saved['rotation'][:3] + (5, 41)}
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, run._cancel)
    timer = threading.Timer(1.0, os.kill, (os.getpid(), signal.SIGTERM)); timer.start()
    try:
        code, rec = lane_rec('rotation', rotation='sleep')
    finally:
        timer.cancel(); run.LANES = saved; run._CANCELLED.clear()
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(s, signal.SIG_DFL)
    WAITS['cancel-kill-reap'] = rec.get('seconds')
    return '%s exit=%d kid=%s' % (rec['status'], code, dead(REPO / 'kid-rotation'))
check('cancel-kill-reap', 'CANCELLED exit=130 kid=reaped', cancel)
check('inputs-unchanged', 'True', lambda: str(frozen() == INPUTS and all(sha(MOD / k) == sha(REPO / 'formal/ci' / k)
      for k in ('run.py', 'tools.py', 'expected.py', 'toolchain.json'))))
check('probes-fake-only', 'True', lambda: str(bool(probes) and all(p.startswith(str(TOOLS)) for p in probes)))
check('starts-python-only', 'True', lambda: str(bool(SPAWNS) and all(a[0] == sys.executable for a in SPAWNS)))
(F / 'results.json').write_text(json.dumps(dict(results=results, waits=WAITS, spawns=len(SPAWNS),
                                                github_env_at_start=ENV_AT_START), indent=2) + '\n')
for r in results:
    print(('ok   ' if r['matched'] else 'FAIL ') + r['case'] + ': ' + r['observed'])
print('%d/%d matched' % (sum(r['matched'] for r in results), len(results)))
raise SystemExit(0 if all(r['matched'] for r in results) else 1)
