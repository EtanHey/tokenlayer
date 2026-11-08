"""Actual local Bun/Python startup controls, owned synthetic files only.
Usage: python3 -I -B check_bun_startup.py <source-root> <absolute-bun> <NEW-fixture-dir>
Run unchanged on the before root to get causal RED (ambient preload/env and stdlib shadowing).
No real formal lane, Java, TLC, network, native source or backend is used.
"""
import ast, hashlib, json, os, shutil, subprocess, sys, time
from pathlib import Path

SOURCE, BUN, OUT = (Path(a).resolve() for a in sys.argv[1:4])
OUT.mkdir(mode=0o700, parents=True, exist_ok=False)
HOME = OUT / 'home'; HOME.mkdir()
ENV = {'PATH': '/usr/bin:/bin', 'HOME': str(HOME), 'TZ': 'UTC'}
rows = []

def call(label, argv, cwd):
    started = time.monotonic()
    child = subprocess.Popen(argv, cwd=cwd, env=ENV, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=10); timeout = False
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, 9); stdout, stderr = child.communicate(); timeout = True
    result = dict(case=label, argv=list(map(str, argv)), exit=child.returncode, timed_out=timeout,
                  wall_s=time.monotonic() - started, stdout=stdout.decode(), stderr=stderr.decode())
    (OUT / (label + '.wait.json')).write_text(json.dumps(result, indent=2) + '\n')
    return result

def record(row, good):
    row['matched'] = bool(good); rows.append(row)
    (OUT / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(('ok   ' if good else 'FAIL ') + row['case'], flush=True)

for lane, file in [('rotation', 'conformance.ts'), ('s2', 'bind.ts')]:
    root = OUT / lane; here = root / 'formal' / ('history-rotation' if lane == 'rotation' else 'history-conformance')
    here.mkdir(parents=True); (root / 'formal/ci').mkdir()
    marker = root / 'AMBIENT_PRELOAD_RAN'
    (root / 'package.json').write_text('{"type":"module"}\n')
    (root / '.env').write_text('TOKENLAYER_OWNED_CONFIG_PROBE=owned\n')
    (root / 'bunfig.toml').write_text('preload=["./ambient.ts"]\n')
    (root / 'ambient.ts').write_text('import { writeFileSync } from "node:fs"; writeFileSync(' + json.dumps(str(marker)) + ', "owned");\n')
    (here / file).write_text('console.log(JSON.stringify({envPresent: process.env.TOKENLAYER_OWNED_CONFIG_PROBE === "owned", args: process.argv.slice(2)}));\n')
    for name in ('bunfig.toml', 'tsconfig.json'):
        p = SOURCE / 'formal/ci' / name
        (root / 'formal/ci' / name).write_bytes(p.read_bytes() if p.exists() else b'')
    runner = SOURCE / 'formal' / here.name / 'check.py'
    candidates = [n.value for n in ast.walk(ast.parse(runner.read_text()))
                  if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'argv' for t in n.targets)
                  and isinstance(n.value, ast.List) and file in ast.unparse(n.value)]
    if len(candidates) != 1:
        raise RuntimeError('ARGV_EXPRESSION_AMBIGUOUS')
    values = dict(BUN=BUN, bun=BUN, ROOT=root, SOURCE=root, HERE=here, source=root / 'journal.ts',
                  out=root / 'output', name='owned', snapshot=root / 'snapshot', scratch=root / 'scratch',
                  run=root / 'result', mode='all')
    argv = eval(compile(ast.Expression(candidates[0]), str(runner), 'eval'), {'str': str}, values)
    result = call(lane + '-startup', argv, root)
    try:
        observed = json.loads(result['stdout'])
    except ValueError:
        observed = None
    expected_args = [str(root / 'journal.ts'), str(root / 'output/owned')] if lane == 'rotation' else [
        str(root / 'snapshot'), str(root / 'scratch'), str(root / 'result/obligations.json'), 'all']
    result.update(ambient_marker=marker.exists(), observed=observed)
    record(result, result['exit'] == 0 and not result['stderr'] and not marker.exists()
           and observed == dict(envPresent=False, args=expected_args))

clone = OUT / 'python-root'; target = clone / 'formal/ci'; target.mkdir(parents=True)
for p in (SOURCE / 'formal/ci').iterdir():
    if p.is_file():
        shutil.copyfile(p, target / p.name)
marker = target / 'SHADOW_RAN'
trace_marker = target / 'TRACEBACK_RAN'
(target / 'argparse.py').write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("owned")\nraise SystemExit(0)\n')
(target / 'traceback.py').write_text('from pathlib import Path\nPath(' + repr(str(trace_marker)) + ').write_text("owned")\n')
before = call('python-no-isolation', [sys.executable, '-B', str(target / 'run.py'), '--help'], clone)
before.update(shadow_marker=marker.exists(), traceback_marker=trace_marker.exists())
record(before, before['exit'] == 1 and before['stderr'].strip() == 'PYTHON_ISOLATION_REQUIRED'
       and not marker.exists() and not trace_marker.exists())
if marker.exists():
    marker.rename(target / 'SHADOW_RAN_BEFORE')  # our fixture marker, retained, not erased
if trace_marker.exists():
    trace_marker.rename(target / 'TRACEBACK_RAN_BEFORE')
isolated = call('python-isolated', [sys.executable, '-I', '-B', str(target / 'run.py'), '--help'], clone)
isolated['shadow_marker'] = marker.exists()
record(isolated, isolated['exit'] == 0 and not isolated['stderr'] and not marker.exists())

# With only traceback planted, reproduce the R1 refusal-display import separately from argparse.
trace_root = OUT / 'traceback-only'; trace_ci = trace_root / 'formal/ci'; trace_ci.mkdir(parents=True)
for p in (SOURCE / 'formal/ci').iterdir():
    if p.is_file():
        shutil.copyfile(p, trace_ci / p.name)
trace_marker = trace_ci / 'TRACEBACK_RAN'
(trace_ci / 'traceback.py').write_text('from pathlib import Path\nPath(' + repr(str(trace_marker)) + ').write_text("owned")\n')
trace = call('python-refusal-display', [sys.executable, '-B', str(trace_ci / 'run.py'), '--help'], trace_root)
trace['traceback_marker'] = trace_marker.exists()
record(trace, trace['exit'] == 1 and trace['stderr'].strip() == 'PYTHON_ISOLATION_REQUIRED' and not trace_marker.exists())
print('%d/%d matched' % (sum(r['matched'] for r in rows), len(rows)))
raise SystemExit(0 if all(r['matched'] for r in rows) else 1)
