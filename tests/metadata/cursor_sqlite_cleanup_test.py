"""B1: tiny owned API/actual-CLI fault controls; no native source access."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'src/metadata/cursor_sqlite.py'
WARNING = 'CURSOR_CLEANUP_WARNING\n'
SENTINEL = 'SYNTHETIC_PRIVATE_CLOSE_SENTINEL'

# Loaded only in these subprocesses; capacity is synthetic, never admission proof.
FAULT_SITE = r'''
import os, sqlite3, sys
from types import SimpleNamespace
mode = os.environ['CURSOR_TEST_FAULT']
trace = os.environ['CURSOR_TEST_TRACE']
active = published = False
cell_fd = None
def event(name):
    with open(trace, 'a') as f:
        f.write(name + '\n')
def fault():
    raise OSError('SYNTHETIC_PRIVATE_CLOSE_SENTINEL')
real_open, real_fdopen, real_close = os.open, os.fdopen, os.close
real_fsync, real_link, real_connect = os.fsync, os.link, sqlite3.connect
os.fstatvfs = lambda _: SimpleNamespace(f_bavail=24*1024**3, f_frsize=1)
def tracked_open(path, *args, **kwargs):
    global cell_fd
    fd = real_open(path, *args, **kwargs)
    if str(path) == 'cells.ndjson':
        cell_fd = fd
    elif fd == cell_fd:
        cell_fd = None  # A closed cell descriptor can be reused by failure.json.
    return fd
class Cells:
    def __init__(self, wrapped): self.wrapped = wrapped
    def __getattr__(self, key): return getattr(self.wrapped, key)
    def write(self, data):
        global active
        if mode == 'write':
            active = True; event('body-write'); fault()
        return self.wrapped.write(data)
    def flush(self):
        global active
        if mode == 'flush':
            active = True; event('body-flush'); fault()
        return self.wrapped.flush()
    def close(self):
        global active
        if mode == 'close' and not active:
            active = True; event('body-close'); self.wrapped.close(); fault()
        if active or mode == 'primary':
            active = True; event('cleanup-cells'); self.wrapped.close(); fault()
        return self.wrapped.close()
def tracked_fdopen(fd, *args, **kwargs):
    f = real_fdopen(fd, *args, **kwargs)
    return Cells(f) if fd == cell_fd else f
class Connection:
    def __init__(self, wrapped): self.wrapped = wrapped
    def __getattr__(self, key): return getattr(self.wrapped, key)
    def close(self):
        global active
        if mode == 'connection-close' and not active:
            active = True; event('body-connection-close'); self.wrapped.close(); fault()
        if active:
            event('cleanup-connection'); self.wrapped.close(); fault()
        return self.wrapped.close()
def tracked_fsync(fd):
    global active
    if mode == 'fsync' and fd == cell_fd:
        active = True; event('body-fsync'); fault()
    return real_fsync(fd)
def tracked_link(*args, **kwargs):
    global published
    result = real_link(*args, **kwargs)
    if args[1] == 'manifest.json':
        published = True; event('published')
    return result
def tracked_close(fd):
    caller = sys._getframe(1)
    role = next((k for k in ('pin','parent','out','root') if caller.f_locals.get(k) == fd), None)
    cleanup = caller.f_code.co_name == 'acquire' and caller.f_locals.get('fd') == fd
    if cleanup and role and (active or published):
        event('cleanup-' + role)
        real_close(fd)
        fault()
    return real_close(fd)
os.open, os.fdopen, os.close = tracked_open, tracked_fdopen, tracked_close
os.fsync, os.link = tracked_fsync, tracked_link
sqlite3.connect = lambda *a, **k: Connection(real_connect(*a, **k))
'''

API = '''
import json, runpy, sys
from pathlib import Path
m = runpy.run_path(sys.argv[1])
try:
    result = m['acquire'](Path(sys.argv[2]), 'run', pending_bytes=0,
        rows=4, total_bytes=4096, value_bytes=2 if sys.argv[3]=='primary' else 1024, seconds=2)
    print(json.dumps({'status':result['status']}))
except m['Refusal'] as error:
    print(json.dumps({'status':'REFUSED','code':error.code}))
    sys.exit(1)
'''


class CleanupTests(unittest.TestCase):
    def run_fault(self, mode, cli=False):
        tag = 'cleanup-' + uuid.uuid4().hex
        fixture = ROOT / '.local/cursor-sqlite-tests' / tag
        fixture.mkdir(mode=0o700, parents=True)
        # Private test HOME/output outside repos; only this fresh owned namespace is used.
        home = Path.home() / '.config/tokenlayer/history-intake' / tag
        home.mkdir(mode=0o700)
        plugin = fixture / 'sitecustomize.py'
        plugin.write_text(FAULT_SITE)
        plugin.chmod(0o600)
        db = fixture / 'owned.db'
        writer = sqlite3.connect(db)
        writer.execute('create table cursorDiskKV(key TEXT PRIMARY KEY,value BLOB)')
        writer.execute('insert into cursorDiskKV values (?,?)', ('bubbleId:synthetic', b'{}\n'))
        writer.commit()
        writer.close()
        trace = fixture / 'events.txt'
        trace.touch(mode=0o600)
        env = dict(os.environ, HOME=str(home), PYTHONPATH=str(fixture), PYTHONDONTWRITEBYTECODE='1',
                   CURSOR_TEST_FAULT=mode, CURSOR_TEST_TRACE=str(trace))
        command = ([sys.executable, str(SOURCE), '--source', str(db), '--run', 'run', '--pending-bytes', '0']
                   if cli else [sys.executable, '-c', API, str(SOURCE), str(db), mode])
        run = subprocess.run(command, env=env, capture_output=True, timeout=10)
        out = home / '.config/tokenlayer/history-intake/run'
        record = dict(mode=mode, cli=cli, exitCode=run.returncode, events=trace.read_text().splitlines(),
                      stdout=run.stdout.decode(), stderr=run.stderr.decode(), output=str(out))
        for name, data in [('result.json', json.dumps(record, sort_keys=True).encode()),
                           ('stdout.txt', run.stdout), ('stderr.txt', run.stderr)]:
            fd = os.open(fixture / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as f: f.write(data)
        return record, out

    def assert_sanitized(self, record):
        self.assertEqual(record['stderr'], WARNING)
        self.assertNotIn(SENTINEL, record['stdout'] + record['stderr'])
        self.assertNotIn('Traceback', record['stdout'] + record['stderr'])

    def test_precommit_data_and_close_fail_closed(self):
        for mode in ('write', 'flush', 'fsync', 'close', 'connection-close'):
            with self.subTest(mode=mode):
                record, out = self.run_fault(mode)
                self.assert_sanitized(record)
                self.assertEqual(record['exitCode'], 1)
                self.assertEqual(json.loads(record['stdout']), dict(status='REFUSED', code='SQLITE_OR_IO_REFUSAL'))
                self.assertFalse((out / 'manifest.json').exists())
                self.assertEqual(json.loads((out / 'failure.json').read_text())['code'], 'SQLITE_OR_IO_REFUSAL')
                expected = (['cleanup-cells'] if mode != 'connection-close' else [])
                self.assertEqual([e for e in record['events'] if e.startswith('cleanup-')],
                                 expected + ['cleanup-connection','cleanup-pin','cleanup-parent','cleanup-out','cleanup-root'])

    def test_primary_refusal_survives_every_cleanup_fault(self):
        record, out = self.run_fault('primary')
        self.assert_sanitized(record)
        self.assertEqual(json.loads(record['stdout']), dict(status='REFUSED', code='OVERSIZE'))
        self.assertEqual(record['exitCode'], 1)
        self.assertEqual(record['events'], ['cleanup-cells','cleanup-connection','cleanup-pin',
                                           'cleanup-parent','cleanup-out','cleanup-root'])
        self.assertFalse((out / 'manifest.json').exists())
        self.assertEqual(json.loads((out / 'failure.json').read_text())['code'], 'OVERSIZE')

    def test_postcommit_actual_cli_preserves_committed_success(self):
        record, out = self.run_fault('post', cli=True)
        self.assert_sanitized(record)
        self.assertEqual(record['exitCode'], 0)
        self.assertEqual(json.loads(record['stdout'])['status'], 'COMPLETE')
        self.assertEqual(record['events'], ['published','cleanup-pin','cleanup-parent','cleanup-out','cleanup-root'])
        self.assertEqual(json.loads((out / 'manifest.json').read_text())['status'], 'COMPLETE')
        self.assertFalse((out / 'failure.json').exists())
