"""Read-decider regression: Python-owned fakes only; no JS, protocols, tools or network.
Usage: python3 -I -B check_read_deciders.py <CI-module-dir> <63-member-source-root> <NEW-fixture-dir>
Uses check_closure.py's owned fixture setup. The original C/D runtime must FAIL the import/helper
controls through causal stale-gate PASSes, not through an unrelated setup refusal.
"""
import contextlib, hashlib, importlib.util, io, json, re, shutil, sys
from pathlib import Path

MOD, SRC, OUT = (Path(a).resolve() for a in sys.argv[1:4])
OUT.mkdir(mode=0o700, parents=True, exist_ok=False)
SOURCE = OUT / 'source'
SOURCE.mkdir()
real = json.loads((MOD / 'closure.json').read_text())
members = sorted({p for e in [real['shared'], *real['lanes'].values()]
                  for role in ('exec', 'input', 'identity') for p in e.get(role, [])})
for rel in members:
    p = SOURCE / rel; p.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(MOD / Path(rel).name if rel.startswith('formal/ci/') else SRC / rel, p)
prefix = (MOD / 'check_closure.py').read_text().split('# 1. The real contract')[0]
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
rows = []

def fixture(label):
    sys.argv = [str(MOD / 'check_closure.py'), str(MOD), str(SOURCE), str(OUT / label)]
    ns = {'__name__': 'owned_read_decider_fixture'}
    exec(compile(prefix, str(MOD / 'check_closure.py'), 'exec'), ns)
    return ns

def all_and_stale(ns, extra=None):
    run, repo = ns['run'], ns['REPO']
    m, out = ns['manifest'](), ns['attempt']()
    s0, p0, buf = len(ns['SPAWNS']), len(ns['probes']), io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = run.main(['all', '--profile', 'local-reviewed', '--expected', str(m), '--out', str(out)])
    result = dict(exit=code, stdout=buf.getvalue(), out=out.exists(),
                  dispatch=len(ns['SPAWNS']) - s0, probes=len(ns['probes']) - p0)
    if (out / 'gate.json').exists():
        result['initial_gate'] = json.loads((out / 'gate.json').read_text())
        result['lanes'] = [json.loads((out / ('lane-' + k) / 'lane.json').read_text())['status'] for k in run.LANES]
        result['consumed'] = {k: json.loads((out / ('lane-' + k) / 'output/consumed.json').read_text()) for k in run.LANES}
        if extra:
            p = repo / extra
            result['extra_bound'] = any(extra in e['sources'] for e in json.loads(m.read_text())['lanes'].values())
            result['before'] = sha(p)
            p.write_text('VALUE = 2\n' if extra.endswith('.py') else 'export const x = 2;\n')
            result['after'] = sha(p)
            result['stale_gate'] = ns['gate']([out / ('lane-' + k) for k in run.LANES], m)
            if extra.endswith('.py'):
                result['actual_helper_after'] = run.resolve(repo / 'formal/history/toolchain.json', 'local-reviewed', None)['owned_helper_value']
    return result

def refused(row, reason):
    return row['exit'] == 1 and not row['out'] and row['dispatch'] == row['probes'] == 0 \
        and row['stdout'].strip().endswith('status=REFUSED error=' + reason)

def record(label, result, matched):
    rows.append(dict(case=label, matched=bool(matched), **result))
    (OUT / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(('ok   ' if matched else 'FAIL ') + label, flush=True)

ns = fixture('positive')
positive = all_and_stale(ns)
record('full-five-positive', positive, positive['exit'] == 0 and positive['lanes'] == ['MATCHED'] * 5
       and positive['initial_gate']['status'] == 'PASS' and positive['dispatch'] == 5 and positive['probes'] == 10
       and all(set(positive['consumed'][k]) == set(ns['members'](ns['REAL'], k)) for k in ns['DIRS']))

for label, statement in [
        ('plain-static', 'import "./added";'),
        ('comment-static', 'import /* owned */ "./added";'),
        ('comment-from', 'export { x } from /* owned */ "./added";'),
        ('plain-dynamic', 'await import("./added");'),
        ('comment-dynamic', 'await import /* owned */ ("./added");'),
        ('dynamic-options', 'await import("./added", { with: { type: "json" } });'),
        ('comment-package', 'import /* owned */ "left-pad";')]:
    ns = fixture(label); repo = ns['REPO']; extra = 'scripts/history/added.ts'
    (repo / extra).write_text('export const x = 1;\n')
    p = repo / 'scripts/history/stream.ts'; p.write_text(p.read_text() + '\n' + statement + '\n')
    b = json.loads((repo / 'behavior.json').read_text())
    for k in ('rotation', 's2'):
        b['reads'][k].append(extra)
    (repo / 'behavior.json').write_text(json.dumps(b))
    row = all_and_stale(ns, extra)
    record(label, row, refused(row, 'CLOSURE_CONSUMER_STALE:rotation:scripts/history/stream.ts,s2:scripts/history/stream.ts'))

for label, expr in [('shared-literal', "'helper.py'"), ('shared-computed', "'helper' + '.py'")]:
    ns = fixture(label); run, repo = ns['run'], ns['REPO']; target = repo / 'formal/ci/tools.py'
    (repo / 'formal/ci/helper.py').write_text('VALUE = 1\n')
    target.write_text(target.read_text() + "\n_owned_resolve = resolve_tools\ndef resolve_tools(*a, **kw):\n"
        "    result = _owned_resolve(*a, **kw)\n"
        "    result['owned_helper_value'] = runpy.run_path(str(Path(__file__).with_name(" + expr + ")))['VALUE']\n"
        "    return result\n")
    try:
        run.tools = run._load('owned_tools', target); run.tools._probe = ns['probe']
        run.resolve = lambda lock, profile, paths: run.tools.resolve_tools(lock, profile, paths=paths or ns['PATHS'])
        row = all_and_stale(ns, 'formal/ci/helper.py')
        good = refused(row, 'CLOSURE_CONSUMER_STALE:shared:formal/ci/tools.py')
    except RuntimeError as error:
        row = dict(bootstrap=str(error), dispatch=len(ns['SPAWNS']), probes=len(ns['probes']))
        good = row == dict(bootstrap='CLOSURE_BOOTSTRAP_STALE:formal/ci/tools.py', dispatch=0, probes=0)
    record(label, row, good)

for label, rel in [('bootstrap-tools-before-exec', 'tools.py'), ('bootstrap-launcher-body', 'run.py')]:
    ns = fixture(label); run, repo = ns['run'], ns['REPO']; target = repo / 'formal/ci' / rel
    marker = ns['F'] / 'UNREVIEWED_CODE_EXECUTED'
    suffix = ('\nPath(' + repr(str(marker)) + ').write_text("bad")\n') if rel == 'tools.py' else '\n# unreviewed launcher body\n'
    target.write_text(target.read_text() + suffix)
    try:
        if rel == 'tools.py':
            run._load('owned_tools', target)
        else:
            spec = importlib.util.spec_from_file_location('owned_run', target)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        reason = 'ACCEPTED'
    except RuntimeError as error:
        reason = str(error)
    row = dict(reason=reason, marker_exists=marker.exists(), dispatch=len(ns['SPAWNS']), probes=len(ns['probes']))
    record(label, row, row == dict(reason='CLOSURE_BOOTSTRAP_STALE:formal/ci/' + rel,
                                  marker_exists=False, dispatch=0, probes=0))

ns = fixture('missing-consumer-schema'); run, repo = ns['run'], ns['REPO']
c = json.loads(ns['CONTRACT'].read_text())
for k in ('rotation', 's2'):
    c['lanes'][k]['consumers'].pop('scripts/history/stream.ts', None)
ns['CONTRACT'].write_text(json.dumps(c)); run.CLOSURE_SHA256 = sha(ns['CONTRACT'])
row = all_and_stale(ns)
record('missing-executable-pin-refuses-schema', row, refused(row, 'CLOSURE_SCHEMA'))

for label, edit in [('missing-launcher-pin', 'missing'), ('duplicate-launcher-pin', 'duplicate')]:
    ns = fixture(label); run, repo = ns['run'], ns['REPO']; target = repo / 'formal/ci/run.py'
    before = target.read_text()
    if edit == 'missing':
        target.write_text(re.sub(r"(?m)^CLOSURE_SHA256 = '[0-9a-f]{64}'$", '', before))
    else:
        target.write_text(before + "\nCLOSURE_SHA256 = '" + run.CLOSURE_SHA256 + "'\n")
    try:
        run._load('owned_tools', repo / 'formal/ci/tools.py'); reason = 'ACCEPTED'
    except RuntimeError as error:
        reason = str(error)
    row = dict(reason=reason, dispatch=len(ns['SPAWNS']), probes=len(ns['probes']))
    record(label, row, row == dict(reason='CLOSURE_BOOTSTRAP_STALE:formal/ci/run.py', dispatch=0, probes=0))

ns = fixture('missing-shared-consumer'); run = ns['run']
c = json.loads(ns['CONTRACT'].read_text())
if 'consumers' in c['shared']:
    c['shared']['consumers'].pop('formal/ci/tools.py')
ns['CONTRACT'].write_text(json.dumps(c)); run.CLOSURE_SHA256 = sha(ns['CONTRACT'])
row = all_and_stale(ns)
record('missing-shared-pin-refuses-schema', row, refused(row, 'CLOSURE_SCHEMA'))
print('%d/%d matched' % (sum(r['matched'] for r in rows), len(rows)))
raise SystemExit(0 if all(r['matched'] for r in rows) else 1)
