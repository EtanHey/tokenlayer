"""Transfer-only fork supervision; the worker never publishes a cache target."""
import json
import math
import multiprocessing
import os
from pathlib import Path
import signal
import tempfile
import threading
from uuid import uuid4


_ERROR_TYPES = {t.__name__: t for t in (RuntimeError, ValueError, TypeError, OSError,
                                      TimeoutError, KeyboardInterrupt, SystemExit)}


def _report(result, outcome):
    payload = json.dumps(outcome).encode('utf-8')
    if len(payload) > 65536:
        raise RuntimeError('TRANSFER_EXCEPTION_LIMIT')
    result.seek(0)
    result.truncate()
    result.write(payload)
    result.flush()


def _transfer(partial, result, pin, opener, official, clock, deadline):
    try:
        total = 0
        with opener(pin['url']) as response:
            official(response.geturl())
            if response.status != 200:
                raise RuntimeError('HTTP_STATUS')
            while True:
                if clock() >= deadline:
                    raise RuntimeError('DOWNLOAD_TIMEOUT')
                block = response.read(min(1048576, pin['size'] - total + 1))
                if clock() >= deadline:
                    raise RuntimeError('DOWNLOAD_TIMEOUT')
                if not block:
                    break
                total += len(block)
                if total > pin['size']:
                    raise RuntimeError('DOWNLOAD_SIZE')
                partial.write(block)
        if clock() >= deadline:
            raise RuntimeError('DOWNLOAD_TIMEOUT')
        _report(result, {'complete': True, 'bytes': total})
    except BaseException as error:
        name = type(error).__name__
        message = str(error)[:4000]
        if type(error) not in _ERROR_TYPES.values():
            name, message = 'RuntimeError', 'TRANSFER_EXCEPTION:' + name + ':' + message[:1000]
        _report(result, {'complete': False, 'type': name, 'args': [message]})


def acquire(cache, artifact, *, lock, sha, require, opener, official, clock, timeout_s):
    """The deadline covers worker open/DNS/redirect/read/EOF/close, not caller scheduling."""
    require(isinstance(timeout_s, (int, float)) and not isinstance(timeout_s, bool)
            and math.isfinite(timeout_s) and 0 < timeout_s <= 120, 'DOWNLOAD_BUDGET')
    # Refuse before filesystem/network/process side effects; never replace caller handlers/timers.
    require(threading.current_thread() is threading.main_thread() and threading.active_count() == 1
            and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL, 'ACQUISITION_CALLER')
    deadline = clock() + timeout_s
    authority = sha(lock)
    pin = json.loads(lock.read_text())['ci-linux-x64-v1'][artifact]
    official(pin['url'])
    require(clock() < deadline, 'DOWNLOAD_TIMEOUT')
    cache = Path(cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / artifact
    if os.path.lexists(target):
        require(not target.is_symlink() and target.is_file()
                and target.stat().st_size == pin['size'] and sha(target) == pin['sha256'], 'CACHE_PIN')
    else:
        partial = cache / (artifact + '.partial-' + uuid4().hex)
        # Exclusive 0600 data inode and unlinked private IPC inode are held across fork.
        # Neither worker writes nor supervisor reads follow a cache-writer's sidecar path.
        fd = os.open(partial, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb', buffering=0) as data, tempfile.TemporaryFile(dir=cache) as result:
            process = multiprocessing.get_context('fork').Process(target=_transfer,
                args=(data, result, pin, opener, official, clock, deadline))
            try:
                require(clock() < deadline, 'DOWNLOAD_TIMEOUT')
                process.start()
                process.join(max(0, deadline - clock()))
                require(not process.is_alive() and clock() < deadline, 'DOWNLOAD_TIMEOUT')
                require(process.exitcode == 0, 'DOWNLOAD_WORKER_EXIT:' + str(process.exitcode))
                result.seek(0)
                payload = result.read(65537)
                require(0 < len(payload) <= 65536, 'DOWNLOAD_RESULT_LIMIT')
                outcome = json.loads(payload)
                require(isinstance(outcome, dict) and type(outcome.get('complete')) is bool,
                        'DOWNLOAD_RESULT_FORMAT')
                if not outcome['complete']:
                    kind, args = _ERROR_TYPES.get(outcome.get('type')), outcome.get('args')
                    require(kind is not None and isinstance(args, list) and len(args) == 1
                            and isinstance(args[0], str) and len(args[0]) <= 4000,
                            'TRANSFER_EXCEPTION_FORMAT')
                    raise kind(*args)
                require(outcome['bytes'] == pin['size'] and sha(partial) == pin['sha256'], 'DOWNLOAD_PIN')
                require(sha(lock) == authority, 'LOCK_DRIFT')
                require(clock() < deadline, 'DOWNLOAD_TIMEOUT')
                os.link(partial, target)  # Only the supervisor publishes after reaping.
            finally:
                if process.pid is not None:
                    if process.is_alive():
                        process.kill()
                    process.join()  # Reap even when the caller raises/cancels.
                process.close()
    require(target.stat().st_size == pin['size'] and sha(target) == pin['sha256'], 'CACHE_DRIFT')
    require(sha(lock) == authority, 'LOCK_DRIFT')
    require(clock() < deadline, 'DOWNLOAD_TIMEOUT')
    return {'status': 'ACQUIRED_UNQUALIFIED', 'path': str(target), 'sha256': pin['sha256'],
            'bytes': pin['size'], 'formal_lane_accepted': False}
