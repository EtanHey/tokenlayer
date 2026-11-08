"""Owned cache-writer discriminators; no real network/tool/source execution."""
import hashlib
import importlib.util
import io
import json
import multiprocessing.process
import os
from pathlib import Path
import pickle
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch

source, root = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
root.mkdir(mode=0o700)
spec = importlib.util.spec_from_file_location('owned_acquisition', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.uuid4 = lambda: SimpleNamespace(hex='owned')
digest = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
def require(ok, code):
    if not ok:
        raise RuntimeError(code)
class Response(io.BytesIO):
    status = 200
    def geturl(self): return 'https://example.invalid/owned'
class Failure(Response):
    status = 503
def setup(name):
    case = root/name; case.mkdir(); cache = case/'cache'; cache.mkdir()
    lock = case/'lock.json'
    lock.write_text(json.dumps({'ci-linux-x64-v1': {'jar': {
        'url': 'https://example.invalid/owned', 'size': 3,
        'sha256': hashlib.sha256(b'jar').hexdigest()}}}))
    def acquire(response=Response):
        return module.acquire(cache, 'jar', lock=lock, sha=digest, require=require,
            opener=lambda url: response(b'jar'), official=lambda url: None,
            clock=time.monotonic, timeout_s=2)
    return case, cache, acquire
results = []
def check(name, fn):
    try:
        fn(); results.append({'name': name, 'pass': True})
    except BaseException as e:
        results.append({'name': name, 'pass': False, 'type': type(e).__name__, 'message': str(e)})
def success():
    case, cache, acquire = setup('success')
    value = acquire()
    assert value['status'] == 'ACQUIRED_UNQUALIFIED' and value['formal_lane_accepted'] is False
    assert (cache/'jar').read_bytes() == b'jar'
def planted_sidecars():
    case, cache, acquire = setup('sidecars'); victim = case/'victim'
    victim.write_bytes(b'owned-outside-cache')
    for suffix in ['.error.pickle', '.result.json']:
        (cache/('jar.partial-owned'+suffix)).symlink_to(victim)
    try: acquire(Failure)
    except RuntimeError as e: assert str(e) == 'HTTP_STATUS'
    else: raise AssertionError('expected HTTP_STATUS')
    assert victim.read_bytes() == b'owned-outside-cache', 'SIDECAR_OVERWROTE_VICTIM'
    assert not (cache/'jar').exists()
def substituted_error():
    case, cache, acquire = setup('substitution'); marker = case/'payload-executed'
    class Payload:
        def __reduce__(self): return os.mkdir, (str(marker),)
    raw = pickle.dumps(Payload())  # Attack input only; production must not decode pickle.
    real_join = multiprocessing.process.BaseProcess.join
    substituted = False
    def join(proc, timeout=None):
        nonlocal substituted
        result = real_join(proc, timeout)
        if timeout is not None and proc.exitcode == 0 and not substituted:
            substituted = True
            (cache/'jar.partial-owned.error.pickle').write_bytes(raw)
        return result
    error = None
    with patch.object(multiprocessing.process.BaseProcess, 'join', join):
        try: acquire(Failure)
        except BaseException as e: error = e
    assert not marker.exists(), 'SUPERVISOR_EXECUTED_PICKLE'
    assert type(error) is RuntimeError and str(error) == 'HTTP_STATUS'
    assert substituted and not (cache/'jar').exists()
def substituted_data_path():
    case, cache, acquire = setup('data-path'); victim = case/'victim'
    victim.write_bytes(b'outside')
    real_start = multiprocessing.process.BaseProcess.start
    def start(proc):
        partial = cache/'jar.partial-owned'
        partial.unlink(); partial.symlink_to(victim)
        return real_start(proc)
    with patch.object(multiprocessing.process.BaseProcess, 'start', start):
        try: acquire()
        except RuntimeError as e: assert str(e) == 'DOWNLOAD_PIN'
        else: raise AssertionError('expected DOWNLOAD_PIN')
    assert victim.read_bytes() == b'outside', 'WORKER_FOLLOWED_DATA_SYMLINK'
    assert not (cache/'jar').exists()
for name, fn in [('success', success), ('planted-sidecars', planted_sidecars),
                 ('substituted-error', substituted_error), ('substituted-data-path', substituted_data_path)]:
    check(name, fn)
print(json.dumps({'cases': len(results), 'pass': sum(r['pass'] for r in results), 'results': results}))
raise SystemExit(0 if all(r['pass'] for r in results) else 1)
