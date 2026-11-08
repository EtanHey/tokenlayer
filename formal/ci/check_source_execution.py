"""Verified helper execution controls: owned caches/markers, actual isolated Python only.
Usage: python3 -I -B check_source_execution.py <runtime-root> <NEW-fixture-dir>
The before loader must fail by executing the harmless cache marker with pinned .py bytes unchanged.
This establishes an owned fixture path, not an attacker/cache-delivery or hosted exploit claim.
"""
import hashlib, importlib.util, json, os, py_compile, shutil, struct, subprocess, sys, time
from pathlib import Path

SOURCE, OUT = (Path(a).resolve() for a in sys.argv[1:3])
OUT.mkdir(mode=0o700, parents=True, exist_ok=False)
HOME = OUT / 'home'; HOME.mkdir()
ENV = {'PATH': '/usr/bin:/bin', 'HOME': str(HOME), 'TZ': 'UTC'}
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
rows = []

def run(label, helper=None, mode=None):
    root = OUT / label; ci = root / 'formal/ci'; ci.mkdir(parents=True)
    for p in (SOURCE / 'formal/ci').iterdir():
        if p.is_file():
            shutil.copyfile(p, ci / p.name)
    pins = {p.name: sha(p) for p in ci.glob('*.py')}
    marker = root / 'UNVERIFIED_CACHE_RAN'
    if helper:
        target = ci / helper
        payload = root / 'owned_payload.py'
        payload.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("owned")\nraise SystemExit(0)\n')
        cache = Path(importlib.util.cache_from_source(str(target))); cache.parent.mkdir(exist_ok=True)
        kind = py_compile.PycInvalidationMode.UNCHECKED_HASH if mode == 'unchecked-hash' else py_compile.PycInvalidationMode.TIMESTAMP
        py_compile.compile(str(payload), cfile=str(cache), dfile=str(target), doraise=True, invalidation_mode=kind)
        if mode == 'timestamp':
            raw = cache.read_bytes(); st = target.stat()
            cache.write_bytes(raw[:8] + struct.pack('<II', int(st.st_mtime) & 0xffffffff, st.st_size & 0xffffffff) + raw[16:])
    argv = [sys.executable, '-I', '-B', str(ci / 'run.py'), '--help']
    started = time.monotonic()
    child = subprocess.Popen(argv, cwd=root, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=10); timeout = False
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, 9); stdout, stderr = child.communicate(); timeout = True
    unchanged = pins == {p.name: sha(p) for p in ci.glob('*.py')}
    row = dict(case=label, helper=helper, cache_mode=mode, argv=argv, actualExit=child.returncode,
               outerTimedOut=timeout, wall_s=time.monotonic() - started, stdout=stdout.decode(),
               stderr=stderr.decode(), sourceUnchanged=unchanged, cacheMarker=marker.exists())
    row['matched'] = unchanged and child.returncode == 0 and not stderr and not marker.exists() and 'usage:' in row['stdout']
    rows.append(row); (OUT / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(('ok   ' if row['matched'] else 'FAIL ') + label, flush=True)

run('clean-positive')
for helper in ('tools.py', 'expected.py', 'closure.py'):
    for mode in ('timestamp', 'unchecked-hash'):
        run(helper.removesuffix('.py') + '-' + mode, helper, mode)
print('%d/%d matched' % (sum(r['matched'] for r in rows), len(rows)))
raise SystemExit(0 if all(r['matched'] for r in rows) else 1)
