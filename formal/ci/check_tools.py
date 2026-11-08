"""Offline boundary controls only: fake bytes/probes/HTTP, no tool execution."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import runpy
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tools', Path(__file__).with_name('tools.py'))
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)
real_probe = tools._probe
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
paths = {k: out / k for k in ('java', 'jar', 'bun')}
for key, path in paths.items():
    path.write_bytes(key.encode()); path.chmod(0o700)
lock = {'jar_sha256': tools.sha(paths['jar']), 'java_sha256': tools.sha(paths['java']),
        'java_version': 'fake java\n'}
local = out / 'local.json'
local.write_text(json.dumps(lock))
common = json.loads(tools.LOCK.read_text())
tools.LOCK = out / 'common.json'
tools.LOCK.write_text(json.dumps(common))
tools._host = lambda: ('Darwin', 'arm64')
calls = []
def probe(path, flag):
    calls.append((str(path), flag))
    return {'exit': 0, 'stdout': 'fake bun\n' if flag == '--version' else '',
            'stderr': 'fake java\n' if flag == '-version' else '', 'timed_out': False}
tools._probe = probe
results = []
def check(name, fn, error=None):
    try:
        value = fn()
        observed = value.get('status') if isinstance(value, dict) else str(value)
        ok = error is None and observed in {'PASS', 'VERIFIED_TOOLS_ONLY', 'ACQUIRED_UNQUALIFIED'}
        ok &= not isinstance(value, dict) or value.get('formal_lane_accepted', False) is False
    except Exception as exc:
        observed = str(exc)
        ok = error is not None and error in observed
    results.append({'case': name, 'expected_error': error, 'observed': observed, 'matched': ok})
def resolve(profile='local-reviewed'):
    return tools.resolve_tools(local, profile, paths=paths)
check('strict-local-positive', resolve)
check('unknown-profile', lambda: resolve('bogus'), 'UNKNOWN_PROFILE')
paths['jar'].write_bytes(b'poison')
check('poisoned-jar', resolve, 'JAR_PIN')
paths['jar'].write_bytes(b'jar')
local.write_text(json.dumps({**lock, 'java_sha256': '0' * 64}))
check('preserve-java-executable-pin', resolve, 'JAVA_PIN')
local.write_text(json.dumps({**lock, 'java_version': 'wrong'}))
check('preserve-java-version-pin', resolve, 'JAVA_VERSION')
local.write_text(json.dumps({'jar_sha256': lock['jar_sha256']}))
check('jar-only-writer-local-authority', resolve)
local.write_text(json.dumps(lock))
paths['bun'] = out / 'missing-bun'
check('missing-bun', resolve, 'MISSING_TOOL')
paths['bun'] = out / 'bun'
tools._probe = lambda *a: {**probe(*a), 'exit': 7}
check('probe-nonzero', resolve, 'VERSION_EXIT')
tools._probe = lambda *a: {**probe(*a), 'timed_out': True}
check('probe-timeout', resolve, 'VERSION_TIMEOUT')
tools._probe = lambda *a: {**probe(*a), 'stderr': 'x' * 65537}
check('probe-output-bound', resolve, 'VERSION_OUTPUT_LIMIT')
tools._probe = probe
before = len(calls)
check('linux-unqualified-on-mac', lambda: resolve('ci-linux-x64-v1'), 'HOST_PROFILE')
tools._host = lambda: ('Linux', 'x86_64')
check('linux-unqualified-no-probes', lambda: resolve('ci-linux-x64-v1'), 'UNQUALIFIED')
check('unqualified-did-not-execute', lambda: {'status': 'PASS'} if len(calls) == before else {}, None)
qualified = copy.deepcopy(common)
qualified['ci-linux-x64-v1']['jar']['sha256'] = lock['jar_sha256']
qualified['ci-linux-x64-v1']['jar']['size'] = 3
# Keep all fake identities within this owned evidence tree.
paths['java'] = out / 'jdk/bin/java'; paths['java'].parent.mkdir(parents=True)
paths['java'].write_bytes(b'java'); paths['java'].chmod(0o700)
release = out / 'jdk/release'; release.write_bytes(b'fake release')
qualified['ci-linux-x64-v1']['qualification'] = {'status': 'HOSTED_REVIEWED',
    'run_url': 'https://github.com/EtanHey/tokenlayer/actions/runs/1',
    'java_sha256': tools.sha(paths['java']), 'java_version': 'fake java\n',
    'release_sha256': tools.sha(release), 'bun_sha256': tools.sha(paths['bun']),
    'bun_version': 'fake bun\n'}
tools.LOCK.write_text(json.dumps(qualified))
check('fake-qualified-linux-positive', lambda: resolve('ci-linux-x64-v1'))
release.write_bytes(b'wrong')
check('linux-release-drift', lambda: resolve('ci-linux-x64-v1'), 'RELEASE_PIN')
release.write_bytes(b'fake release')
def drift_probe(*args):
    value = probe(*args); paths['jar'].write_bytes(b'changed'); return value
tools._probe = drift_probe
check('bytes-change-during-probe', lambda: resolve('ci-linux-x64-v1'), 'TOOL_DRIFT')
paths['jar'].write_bytes(b'jar'); tools._probe = probe
def lock_drift(*args):
    value = probe(*args); tools.LOCK.write_text(json.dumps(qualified) + '\n'); return value
tools._probe = lock_drift
check('lock-changes-during-probe', lambda: resolve('ci-linux-x64-v1'), 'LOCK_DRIFT')
tools._probe = probe
for key in ('java_version', 'java_sha256', 'release_sha256', 'bun_sha256', 'bun_version', 'run_url'):
    bad = copy.deepcopy(qualified); del bad['ci-linux-x64-v1']['qualification'][key]
    tools.LOCK.write_text(json.dumps(bad))
    check('qualification-missing-' + key, lambda: resolve('ci-linux-x64-v1'), 'QUALIFICATION_FIELDS')
tools.LOCK.write_text(json.dumps(common))
class Reply(io.BytesIO):
    def geturl(self): return common['ci-linux-x64-v1']['jar']['url']
    status = 200
tools._open = lambda url: Reply(b'jar')
fake = copy.deepcopy(common)
fake['ci-linux-x64-v1']['jar'].update(size=3, sha256=lock['jar_sha256'])
tools.LOCK.write_text(json.dumps(fake))
cache = out / 'cache'
check('explicit-fake-acquisition', lambda: tools.acquire(cache, 'jar'))
tools._open = lambda url: (_ for _ in ()).throw(RuntimeError('NETWORK_MUST_NOT_RUN'))
check('verified-cache-no-network', lambda: tools.acquire(cache, 'jar'))
(cache / 'jar').write_bytes(b'bad')
check('poisoned-cache-no-repair', lambda: tools.acquire(cache, 'jar'), 'CACHE_PIN')
tools._open = lambda url: Reply(b'too large')
check('download-overflow', lambda: tools.acquire(out / 'overflow', 'jar'), 'DOWNLOAD_SIZE')
tools._open = lambda url: Reply(b'bad')
check('download-wrong-hash', lambda: tools.acquire(out / 'wrong-hash', 'jar'), 'DOWNLOAD_PIN')
check('unknown-artifact', lambda: tools.acquire(out / 'unknown', 'bogus'), 'UNKNOWN_ARTIFACT')
check('http-refused', lambda: tools._official('http://github.com/x'), 'OFFICIAL_HTTPS_ONLY')
check('foreign-redirect-refused', lambda: tools._Redirect().redirect_request(
    None, None, 302, '', {}, 'https://example.org/payload'), 'OFFICIAL_HTTPS_ONLY')
class Foreign(Reply):
    def geturl(self): return 'https://example.org/payload'
tools._open = lambda url: Foreign(b'jar')
check('foreign-response-refused', lambda: tools.acquire(out / 'foreign', 'jar'), 'OFFICIAL_HTTPS_ONLY')
tools._open = lambda url: Reply(b'jar')
with patch.object(tools.time, 'monotonic', side_effect=[0, 121]):
    check('download-deadline', lambda: tools.acquire(out / 'deadline', 'jar'), 'DOWNLOAD_TIMEOUT')
symlink = out / 'symlink-cache'; symlink.mkdir(); (symlink / 'jar').symlink_to(paths['jar'])
check('cache-symlink-refused', lambda: tools.acquire(symlink, 'jar'), 'CACHE_PIN')
tools._host = lambda: ('Darwin', 'arm64')
check('no-acquisition-on-mac', lambda: tools.acquire(out / 'mac', 'jar'), 'HOST_PROFILE')
class Child:
    pid = 999999
    def __init__(self, argv, **kw):
        Child.last = self
        assert argv == [str(paths['java']), '-version'] and kw['start_new_session']
        assert not tools._JAVA_ENV.intersection(kw['env'])
        assert kw['preexec_fn'] is tools._limit
        kw['stderr'].write(b'fake java\n'); self.waits = 0
    def wait(self, timeout=None):
        self.waits += 1
        if timeout is not None: raise tools.subprocess.TimeoutExpired('fake', timeout)
        return -9
with patch.dict(tools.os.environ, {k: 'fake' for k in tools._JAVA_ENV}), \
        patch.object(tools.subprocess, 'Popen', Child), patch.object(tools.os, 'killpg') as kill:
    def timeout_control():
        result = real_probe(paths['java'], '-version')
        assert result == {'exit': -9, 'stdout': '', 'stderr': 'fake java\n', 'timed_out': True}
        kill.assert_called_once_with(Child.pid, tools.signal.SIGKILL)
        return {'status': 'PASS'}
    check('fake-process-timeout-kill-reap-sanitized-env', timeout_control)
class Interrupted(Child):
    def wait(self, timeout=None):
        if timeout is not None: self.waits += 1; raise KeyboardInterrupt()
        return super().wait()
with patch.object(tools.subprocess, 'Popen', Interrupted), patch.object(tools.os, 'killpg') as kill:
    def cancel_control():
        try: real_probe(paths['java'], '-version')
        except KeyboardInterrupt: pass
        else: raise AssertionError('cancellation swallowed')
        kill.assert_called_once_with(Child.pid, tools.signal.SIGKILL)
        assert Child.last.waits == 2
        return {'status': 'PASS'}
    check('fake-probe-cancellation-kill-reap', cancel_control)
transfer = runpy.run_path(str(Path(__file__).with_name('check_transfer.py')))
transfer['review_controls'](tools, out, check, common)
transfer['os_controls'](tools, out, check, common)
(out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'scope': 'OFFLINE_SYNTHETIC_OS_AND_INJECTED_BOUNDARIES', 'cases': len(results),
                  'matched': sum(r['matched'] for r in results), 'results': results}))
raise SystemExit(0 if all(r['matched'] for r in results) else 1)
