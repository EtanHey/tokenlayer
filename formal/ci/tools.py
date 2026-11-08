"""Strict tool identity boundary. Resolution never downloads or modifies locks."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import signal
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
import runpy

LOCK = Path(__file__).with_name('toolchain.json')
_JAVA_ENV = {'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'}
_host = lambda: (platform.system(), platform.machine())


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def _limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))


def _probe(path, flag):
    env = {k: v for k, v in os.environ.items() if k not in _JAVA_ENV}
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen([str(path), flag], stdout=out, stderr=err, env=env,
                             start_new_session=True, preexec_fn=_limit)
        timeout = False
        try:
            code = p.wait(timeout=5)
        except BaseException as error:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            code = p.wait()
            if not isinstance(error, subprocess.TimeoutExpired):
                raise
            timeout = True
        out.seek(0); err.seek(0)
        return {'exit': code, 'stdout': out.read(65537).decode('utf-8'),
                'stderr': err.read(65537).decode('utf-8'), 'timed_out': timeout}


def _version(path, flag):
    v = _probe(path, flag)
    require(not v['timed_out'], 'VERSION_TIMEOUT')
    require(len((v['stdout'] + v['stderr']).encode()) <= 65536, 'VERSION_OUTPUT_LIMIT')
    require(v['exit'] == 0, 'VERSION_EXIT:' + str(v['exit']))
    require(bool(v['stdout'] + v['stderr']), 'VERSION_EMPTY')
    return v['stdout'] + v['stderr']


def resolve_tools(local_lock, profile='local-reviewed', *, paths=None):
    """local_lock is the unchanged protocol lock path; paths are explicit, never PATH lookup."""
    require(profile in {'local-reviewed', 'ci-linux-x64-v1'}, 'UNKNOWN_PROFILE')
    supplied_lock = Path(local_lock).absolute()
    local_lock = supplied_lock.resolve(strict=True)
    authorities = {local_lock: sha(local_lock), LOCK: sha(LOCK)}
    local = json.loads(local_lock.read_text())
    # D1: a separate profile may select other jar bytes; report, never equate, the protocol pin.
    protocol_jar = local.get('jar_sha256') if isinstance(local, dict) else None
    pin, jar_size = local, None
    if profile == 'ci-linux-x64-v1':
        require(_host() == ('Linux', 'x86_64'), 'HOST_PROFILE')
        ci = json.loads(LOCK.read_text())[profile]
        pin = ci['qualification']
        require(isinstance(pin, dict) and pin.get('status') == 'HOSTED_REVIEWED', 'UNQUALIFIED')
        require(all(isinstance(pin.get(k), str) and pin[k] for k in
                    ['java_version', 'bun_version', 'java_sha256', 'bun_sha256', 'release_sha256', 'run_url']),
                'QUALIFICATION_FIELDS')
        require(all(re.fullmatch('[0-9a-f]{64}', pin[k]) for k in
                    ['java_sha256', 'bun_sha256', 'release_sha256']), 'QUALIFICATION_HASH')
        require(re.fullmatch(r'https://github.com/EtanHey/tokenlayer/actions/runs/[1-9]\d*', pin['run_url']),
                'QUALIFICATION_URL')
        pin = {**pin, 'jar_sha256': ci['jar']['sha256']}
        jar_size = ci['jar']['size']
    else:
        require(_host()[0] == 'Darwin', 'HOST_PROFILE')
    require(paths is not None or profile == 'local-reviewed', 'EXPLICIT_CI_PATHS_REQUIRED')
    selected = paths if paths is not None else {
        'java': Path('/opt/homebrew/opt/openjdk/bin/java'),
        'jar': Path.home() / '.cache/tla/tla2tools.jar', 'bun': Path.home() / '.bun/bin/bun'}
    require(set(selected) == {'java', 'jar', 'bun'}, 'TOOL_PATH_FIELDS')
    require(all(Path(p).is_file() for p in selected.values()), 'MISSING_TOOL')
    resolved = {k: Path(p).resolve(strict=True) for k, p in selected.items()}
    require(all(os.access(resolved[k], os.X_OK) for k in ('java', 'bun')), 'NOT_EXECUTABLE')
    before = {k: sha(p) for k, p in resolved.items()}
    require(before['jar'] == pin['jar_sha256'], 'JAR_PIN')
    require(jar_size is None or resolved['jar'].stat().st_size == jar_size, 'JAR_SIZE')
    for key in ('java', 'bun'):
        require(key + '_sha256' not in pin or before[key] == pin[key + '_sha256'], key.upper() + '_PIN')
    release = None
    if profile != 'local-reviewed':
        release = resolved['java'].parent.parent / 'release'
        require(release.is_file() and sha(release) == pin['release_sha256'], 'RELEASE_PIN')
    versions = {k: _version(resolved[k], '-version' if k == 'java' else '--version') for k in ('java', 'bun')}
    for key in ('java', 'bun'):
        require(key + '_version' not in pin or versions[key] == pin[key + '_version'], key.upper() + '_VERSION')
    require(all(sha(p) == before[k] and Path(selected[k]).resolve(strict=True) == p
                for k, p in resolved.items()), 'TOOL_DRIFT')
    require(supplied_lock.resolve(strict=True) == local_lock and supplied_lock.is_file()
            and sha(supplied_lock) == authorities[local_lock], 'LOCK_PATH_DRIFT')
    require(all(resolved[k].is_file() and os.access(resolved[k], os.X_OK)
                for k in ('java', 'bun')), 'NOT_EXECUTABLE')
    require(all(sha(p) == h for p, h in authorities.items()), 'LOCK_DRIFT')
    require(release is None or sha(release) == pin['release_sha256'], 'RELEASE_DRIFT')
    return {'status': 'VERIFIED_TOOLS_ONLY', 'profile': profile,
            **{k: str(p) for k, p in resolved.items()},
            'sha256': before, 'versions': versions,
            'authority_sha256': {str(p): h for p, h in authorities.items()},
            'jar_provenance': {'protocol_lock_sha256': protocol_jar, 'selected_profile_sha256': pin['jar_sha256'],
                               'protocol_pin_matched': before['jar'] == protocol_jar},
            'qualification_run': pin.get('run_url'), 'formal_lane_accepted': False}


def _official(url):
    u = urlsplit(url)
    require(u.scheme == 'https' and not u.username and not u.password and u.port in (None, 443)
            and u.hostname in {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'},
            'OFFICIAL_HTTPS_ONLY')


class _Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _official(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url):
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _Redirect()).open(url, timeout=15)


def acquire(cache, artifact, *, timeout_s=120):
    """Explicit supervised Linux transfer; timeout may only shorten the120s ceiling."""
    require(_host() == ('Linux', 'x86_64'), 'HOST_PROFILE')
    require(artifact in {'jar', 'jdk_archive'}, 'UNKNOWN_ARTIFACT')
    implementation = runpy.run_path(str(Path(__file__).with_name('acquisition.py')))
    return implementation['acquire'](cache, artifact, lock=LOCK, sha=sha, require=require,
        opener=_open, official=_official, clock=time.monotonic, timeout_s=timeout_s)
