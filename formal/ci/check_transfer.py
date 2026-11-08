"""Review discriminators plus scaled synthetic OS supervision; no network/tools."""
import copy
import io
import json
import multiprocessing.process
import os
from pathlib import Path
import signal
import time
from unittest.mock import patch


def review_controls(tools, out, check, common):
    def fixture(name):
        root = out / name; root.mkdir()
        paths = {k: root / k for k in ('java', 'jar', 'bun')}
        for k, p in paths.items():
            p.write_bytes(('synthetic ' + k).encode()); p.chmod(0o700)
        local = root / 'local.json'
        pin = {'jar_sha256': tools.sha(paths['jar']), 'java_sha256': tools.sha(paths['java']),
               'java_version': 'synthetic java\n', 'bun_sha256': tools.sha(paths['bun']),
               'bun_version': 'synthetic bun\n'}
        local.write_text(json.dumps(pin)); tools.LOCK = root / 'common.json'
        tools.LOCK.write_text(json.dumps(common))
        return root, paths, local, pin

    def probe(p, flag):
        return {'exit': 0, 'stdout': 'synthetic bun\n' if flag == '--version' else '',
                'stderr': 'synthetic java\n' if flag == '-version' else '', 'timed_out': False}

    with patch.object(tools, '_host', return_value=('Darwin', 'arm64')):
        root, paths, local, pin = fixture('review-alias')
        alias, alternate = root / 'protocol-lock-alias.json', root / 'alternate.json'
        alternate.write_text(json.dumps({**pin, 'java_version': 'different'}))
        state = {'retargeted': False}; real_resolve = Path.resolve
        def resolve_alias(self, *a, **kw):
            if self == alias: return alternate if state['retargeted'] else local
            return real_resolve(self, *a, **kw)
        def retarget(p, flag):
            state['retargeted'] = True; return probe(p, flag)
        with patch.object(Path, 'resolve', resolve_alias), patch.object(tools, '_probe', side_effect=retarget):
            check('A2-supplied-lock-alias-retarget-during-resolve',
                  lambda: tools.resolve_tools(alias, paths=paths), 'LOCK_PATH_DRIFT')
        root, paths, local, pin = fixture('review-execute')
        def revoke(p, flag):
            if flag == '--version': paths['java'].chmod(0o600)
            return probe(p, flag)
        with patch.object(tools, '_probe', side_effect=revoke):
            check('A3-java-loses-execute-bit-during-resolve',
                  lambda: tools.resolve_tools(local, paths=paths), 'NOT_EXECUTABLE')
    root, paths, local, pin = fixture('review-eof')
    locked = copy.deepcopy(common)
    locked['ci-linux-x64-v1']['jar'].update(size=3, sha256=__import__('hashlib').sha256(b'jar').hexdigest())
    tools.LOCK.write_text(json.dumps(locked)); clock = {'now': 0}
    class LateEOF(io.BytesIO):
        status = 200
        def geturl(self): return locked['ci-linux-x64-v1']['jar']['url']
        def read(self, n):
            block = super().read(n)
            if not block: clock['now'] = 10000
            return block
    with patch.object(tools, '_host', return_value=('Linux', 'x86_64')), \
            patch.object(tools.time, 'monotonic', side_effect=lambda: clock['now']), \
            patch.object(tools, '_open', side_effect=lambda u: LateEOF(b'jar')):
        check('A1-response-eof-completes-after-total-deadline',
              lambda: tools.acquire(root / 'cache', 'jar'), 'DOWNLOAD_TIMEOUT')


def os_controls(tools, out, check, common):
    tools._host = lambda: ('Linux', 'x86_64')
    tools.LOCK = out / 'os-common.json'
    pin = copy.deepcopy(common)
    pin['ci-linux-x64-v1']['jar'].update(size=3, sha256=__import__('hashlib').sha256(b'jar').hexdigest())
    tools.LOCK.write_text(json.dumps(pin))
    def assert_reaped(marker):
        pid = int(marker.read_text())
        try: os.waitpid(pid, os.WNOHANG)
        except ChildProcessError: return
        raise AssertionError('supervised worker not reaped')
    for phase in ('open', 'read'):
        root = out / ('os-' + phase); root.mkdir(); marker = root / 'pid'
        class Progress(io.BytesIO):
            status = 200
            def geturl(self): return pin['ci-linux-x64-v1']['jar']['url']
            def read(self, n):
                if self.tell() == 0: return super().read(n)
                # This read makes progress internally but cannot return to the caller's clock.
                with (root / 'progress').open('ab', buffering=0) as stream:
                    for _ in range(200):
                        stream.write(b'p'); time.sleep(0.01)
                return b''
        def opener(url):
            marker.write_text(str(os.getpid()))
            if phase == 'open': time.sleep(2)
            return Progress(b'jar')
        def supervised():
            started = time.monotonic()
            try: tools.acquire(root / 'cache', 'jar', timeout_s=0.2)
            except RuntimeError as e: assert str(e) == 'DOWNLOAD_TIMEOUT'
            else: raise AssertionError('late transfer accepted')
            elapsed = time.monotonic() - started
            assert 0.15 <= elapsed < 2
            assert_reaped(marker); assert not (root / 'cache/jar').exists()
            partial = next((root / 'cache').glob('jar.partial-*'))
            assert partial.read_bytes() == (b'jar' if phase == 'read' else b'')
            if phase == 'read': assert (root / 'progress').stat().st_size > 0
            (root / 'proof.json').write_text(json.dumps({'elapsed_s': elapsed, 'worker_reaped': True,
                'partial_bytes': partial.stat().st_size, 'published': False}))
            return {'status': 'PASS'}
        tools._open = opener
        check('OS-supervised-progressing-' + phase, supervised)
    tools._open = lambda url: (_ for _ in ()).throw(ValueError('synthetic transport failure'))
    def transport_error():
        try: tools.acquire(out / 'exception', 'jar')
        except ValueError as e:
            assert str(e) == 'synthetic transport failure'; return {'status': 'PASS'}
        raise AssertionError('transport exception lost')
    check('transport-exception-preserved', transport_error)
    tools._open = lambda url: (_ for _ in ()).throw(KeyboardInterrupt('synthetic child cancellation'))
    def cancelled_child():
        try: tools.acquire(out / 'child-cancel', 'jar')
        except KeyboardInterrupt as e:
            assert str(e) == 'synthetic child cancellation'; return {'status': 'PASS'}
        raise AssertionError('child cancellation swallowed')
    check('child-cancellation-preserved', cancelled_child)
    root = out / 'parent-cancel'; root.mkdir(); marker = root / 'pid'
    ready = __import__('multiprocessing').get_context('fork').Event()
    def blocked_open(url):
        marker.write_text(str(os.getpid())); ready.set(); time.sleep(2)
        raise AssertionError('cancelled opener returned')
    tools._open = blocked_open
    real_join = multiprocessing.process.BaseProcess.join
    def interrupt_join(process, timeout=None):
        if timeout is not None:
            assert ready.wait(1)
            raise KeyboardInterrupt('synthetic parent cancellation')
        return real_join(process, timeout)
    def cancelled_parent():
        with patch.object(multiprocessing.process.BaseProcess, 'join', interrupt_join):
            try: tools.acquire(root / 'cache', 'jar')
            except KeyboardInterrupt as e: assert str(e) == 'synthetic parent cancellation'
            else: raise AssertionError('parent cancellation swallowed')
        assert_reaped(marker); assert not (root / 'cache/jar').exists()
        return {'status': 'PASS'}
    check('parent-cancellation-reaps-worker', cancelled_parent)
    def timer_state():
        original = signal.getsignal(signal.SIGALRM)
        assert signal.getitimer(signal.ITIMER_REAL) == (0, 0)
        def alarm(*args): raise AssertionError('caller timer unexpectedly fired')
        try:
            signal.signal(signal.SIGALRM, alarm); signal.setitimer(signal.ITIMER_REAL, 5)
            tools._open = lambda url: (_ for _ in ()).throw(ValueError('timer control'))
            try: tools.acquire(out / 'timer', 'jar')
            except ValueError: pass
            assert signal.getsignal(signal.SIGALRM) is alarm
            assert 0 < signal.getitimer(signal.ITIMER_REAL)[0] <= 5
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, original)
        return {'status': 'PASS'}
    check('caller-timer-handler-preserved', timer_state)
    with patch('threading.active_count', return_value=2):
        check('unsupported-caller-before-side-effects', lambda: tools.acquire(out / 'threaded', 'jar'), 'ACQUISITION_CALLER')
    assert not (out / 'threaded').exists()
    def caller_handler(*args): pass
    with patch.object(signal, 'getsignal', return_value=caller_handler):
        check('caller-sigchld-not-hijacked', lambda: tools.acquire(out / 'handler', 'jar'), 'ACQUISITION_CALLER')
    assert not (out / 'handler').exists()
