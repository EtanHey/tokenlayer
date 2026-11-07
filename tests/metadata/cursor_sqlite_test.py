"""Owned fixtures only. Run with python3 -m unittest discover -s tests/metadata -p '*_test.py'."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('cursor_sqlite', ROOT / 'src/metadata/cursor_sqlite.py')
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.tag = 'synthetic-' + uuid.uuid4().hex
        self.home = ROOT / '.local/cursor-sqlite-tests' / self.tag
        self.home.mkdir(mode=0o700, parents=True)
        self.db = self.home / 'owned.db'
        self.writer = sqlite3.connect(self.db)
        self.writer.execute('pragma journal_mode=WAL')
        self.writer.execute('create table cursorDiskKV(key TEXT PRIMARY KEY,value BLOB)')
        self.add('bubbleId:a', '{"clock":null,"tokens":0}')

    def tearDown(self):
        self.writer.close()

    def add(self, key, value):
        self.writer.execute('insert or replace into cursorDiskKV values (?,?)', (key, value))
        self.writer.commit()

    def run_intake(self, **kw):
        receipt = dict(status='UNEXPECTED_TEST_EXCEPTION')
        try:
            result = reader.acquire(self.db, self.tag + '-' + uuid.uuid4().hex, pending_bytes=0, **kw)
            receipt = {k: result[k] for k in ('status', 'counts', 'selectionDigest', 'cellsSha256', 'output')}
            return result
        except reader.Refusal as error:
            receipt = dict(status='REFUSED', code=error.code, output=error.output)
            if error.output:
                receipt['failure'] = json.loads((Path(error.output) / 'failure.json').read_text())
            raise
        finally:
            fd = os.open(self.home / 'controls.ndjson', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'ab') as f:
                f.write(json.dumps(receipt, sort_keys=True).encode() + b'\n')

    def cells(self, manifest):
        return [json.loads(x) for x in (Path(manifest['output']) / 'cells.ndjson').read_text().splitlines()]

    def test_exact_allowlist_and_states(self):
        import base64
        self.add('auth.secret', 'SYNTHETIC_AUTH_SENTINEL')
        self.writer.execute('create table ItemTable(key TEXT,value TEXT)')
        self.writer.execute('insert into ItemTable values (?,?)', ('bubbleId:excluded', 'EXCLUDED'))
        self.writer.commit()
        for key, value in [('bubbleId:b', None), ('bubbleId:c', b'bad\xff'),
                           ('composerData:a', '"שלום"'), ('composerData:b', 'null')]:
            self.add(key, value)
        m = self.run_intake()
        rows = self.cells(m)
        self.assertEqual(m['counts'], dict(selected=5, retained=4, held=1, tombstone=2, invalid=1))
        self.assertEqual(base64.b64decode(rows[0]['valueBase64']), b'{"clock":null,"tokens":0}')
        self.assertEqual(rows[3]['bytes'], len('"שלום"'.encode()))
        self.assertEqual(rows[3]['sqliteType'], 'text')
        self.assertNotIn('SYNTHETIC_AUTH_SENTINEL', json.dumps(rows))
        self.assertEqual(m['originMachine'], 'UNKNOWN')

    def test_wal_snapshot_and_revision(self):
        first = self.run_intake()
        original = self.cells(first)[0]
        def concurrent_write():
            self.add('bubbleId:a', '{"revised":true}')
            self.add('bubbleId:z', '{}')
        stable = self.run_intake(_after_snapshot=concurrent_write)
        self.assertEqual(self.cells(stable)[0]['cellDigest'], original['cellDigest'])
        self.assertEqual(self.cells(stable)[0]['replayId'], original['replayId'])
        self.assertEqual(stable['counts']['selected'], 1)
        revised = self.run_intake()
        self.assertNotEqual(self.cells(revised)[0]['cellDigest'], original['cellDigest'])
        copy = self.home / 'copy.db'
        dst = sqlite3.connect(copy)
        self.writer.backup(dst)  # Owned synthetic fixture only; reader never calls backup.
        dst.execute('insert into cursorDiskKV values (?,?)', ('auth.copy', 'EXCLUDED'))
        dst.commit()  # Keep the owned copy WAL/SHM present; no source-side creation by the reader.
        alias = reader.acquire(copy, self.tag + '-copy', pending_bytes=0)
        dst.close()
        self.assertEqual(alias['selectionDigest'], revised['selectionDigest'])
        self.assertNotEqual(self.cells(alias)[0]['replayId'], self.cells(revised)[0]['replayId'])

    def test_refusals_and_no_success(self):
        cases = [('OVERSIZE', {'value_bytes': 2}), ('ROW_LIMIT', {'rows': 1}),
                 ('BYTE_LIMIT', {'total_bytes': 2}), ('LIMITS', {'rows': True}),
                 ('TIME_LIMIT', {'_after_snapshot': lambda: __import__('time').sleep(.03), 'seconds': .01})]
        self.add('bubbleId:b', '{}')
        for code, options in cases:
            with self.subTest(code=code), self.assertRaises(reader.Refusal) as raised:
                self.run_intake(**options)
            self.assertEqual(raised.exception.code, code)
            if raised.exception.output:
                out = Path(raised.exception.output)
                self.assertFalse((out / 'manifest.json').exists())
                self.assertTrue((out / 'partial.json').exists())
                self.assertEqual(json.loads((out / 'failure.json').read_text())['code'], code)

    def test_identity_private_and_no_overwrite(self):
        link = self.home / 'link.db'
        link.symlink_to(self.db)
        with self.assertRaises(reader.Refusal):
            reader.acquire(link, self.tag + '-link', pending_bytes=0)
        def replace():
            self.db.rename(self.home / 'moved.db')
            self.db.write_bytes(b'replacement')
        with self.assertRaises(reader.Refusal) as raised:
            self.run_intake(_after_snapshot=replace)
        self.assertEqual(raised.exception.code, 'SOURCE_CHANGED')
        self.db.unlink()  # Only this test's replacement, not the retained original.
        (self.home / 'moved.db').rename(self.db)
        m = reader.acquire(self.db, self.tag, pending_bytes=0)
        out = Path(m['output'])
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        for child in out.iterdir():
            self.assertEqual(child.stat().st_mode & 0o777, 0o600)
        self.assertEqual((out / 'manifest.json').stat().st_ino, (out / 'manifest.pending').stat().st_ino)
        with self.assertRaises(reader.Refusal):
            reader.acquire(self.db, self.tag, pending_bytes=0)

    def test_schema_key_and_wal_sidecar_refusals(self):
        self.add(sqlite3.Binary(b'bubbleId:blob-key'), '{}')
        with self.assertRaises(reader.Refusal) as raised:
            self.run_intake()
        self.assertEqual(raised.exception.code, 'KEY_TYPE')
        self.writer.execute('delete from cursorDiskKV where typeof(key)=?', ('blob',))
        self.writer.execute('alter table cursorDiskKV add column surprise TEXT')
        self.writer.commit()
        with self.assertRaises(reader.Refusal) as raised:
            self.run_intake()
        self.assertEqual(raised.exception.code, 'SCHEMA')
        self.writer.close()  # Last writer removes WAL/SHM normally; do not let reader create them.
        with self.assertRaises(reader.Refusal) as raised:
            self.run_intake()
        self.assertEqual(raised.exception.code, 'WAL_MISSING_SIDECARS')
        self.assertFalse(Path(str(self.db) + '-wal').exists())
        self.assertFalse(Path(str(self.db) + '-shm').exists())

    def test_lock_and_floor_pending(self):
        self.writer.close()
        self.writer = sqlite3.connect(self.db)
        self.writer.execute('pragma journal_mode=DELETE')
        self.writer.execute('begin exclusive')
        with self.assertRaises(reader.Refusal) as raised:
            self.run_intake(seconds=.03)
        self.assertIn(raised.exception.code, ('TIME_LIMIT', 'SQLITE_LOCKED'))
        self.writer.rollback()
        fake = type('FS', (), dict(f_bavail=reader.FLOOR + 1, f_frsize=1))()
        with patch.object(reader.os, 'fstatvfs', return_value=fake), self.assertRaises(reader.Refusal) as raised:
            self.run_intake()
        self.assertEqual(raised.exception.code, 'SPACE')
        with self.assertRaises(reader.Refusal) as raised:
            reader.acquire(self.db, self.tag + '-pending', pending_bytes=2**60)
        self.assertEqual(raised.exception.code, 'SPACE')

    def test_output_substitution_is_held_and_anchored(self):
        run = self.tag + '-swap'
        original = reader.OUTPUT / run
        moved = reader.OUTPUT / (run + '-retained')
        def substitute():
            original.rename(moved)
            original.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(reader.Refusal) as raised:
            reader.acquire(self.db, run, pending_bytes=0, _after_snapshot=substitute)
        self.assertEqual(raised.exception.code, 'OUTPUT_CHANGED')
        self.assertFalse((self.home / 'cells.ndjson').exists())
        self.assertFalse((moved / 'manifest.json').exists())
        self.assertEqual(json.loads((moved / 'failure.json').read_text())['code'], 'OUTPUT_CHANGED')

    def test_killed_process_retains_partial_only(self):
        import subprocess
        import sys
        run = self.tag + '-killed'
        script = ('import importlib.util,os,signal; from pathlib import Path; '
                  f's=importlib.util.spec_from_file_location("reader",{str(SPEC.origin)!r}); '
                  'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
                  f'm.acquire(Path({str(self.db)!r}),{run!r},pending_bytes=0,'
                  '_after_snapshot=lambda:os.kill(os.getpid(),signal.SIGKILL))')
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, -9)
        self.assertEqual(result.stdout + result.stderr, b'')
        out = reader.OUTPUT / run
        self.assertTrue((out / 'partial.json').exists())
        self.assertFalse((out / 'manifest.json').exists())

    def test_encoding_sql_byte_gate_and_source_bytes_unchanged(self):
        import base64
        import hashlib
        def source_hashes():
            return [hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in (self.db, Path(str(self.db) + '-wal'))]
        before = source_hashes()
        self.run_intake()
        self.assertEqual(source_hashes(), before)
        self.add('bubbleId:a', '"שלום"')
        with self.assertRaises(reader.Refusal) as raised:
            self.run_intake(value_bytes=8)  # Six characters require ten UTF-8 bytes.
        self.assertEqual(raised.exception.code, 'OVERSIZE')
        out = Path(raised.exception.output)
        rows = [json.loads(x) for x in (out / 'cells.ndjson').read_text().splitlines()]
        self.assertEqual(rows[-1]['status'], 'OVERSIZE')
        self.assertIsNone(rows[-1]['valueBase64'])
        utf = self.home / 'utf16.db'
        c = sqlite3.connect(utf)
        c.execute("pragma encoding='UTF-16le'")
        c.execute('create table cursorDiskKV(key TEXT PRIMARY KEY,value BLOB)')
        c.execute('insert into cursorDiskKV values (?,?)', ('bubbleId:u', '"שלום"'))
        c.commit()
        m = reader.acquire(utf, self.tag + '-utf16', pending_bytes=0)
        c.close()
        row = self.cells(m)[0]
        self.assertEqual(base64.b64decode(row['valueBase64']), '"שלום"'.encode('utf-16-le'))
        self.assertEqual(row['sqliteEncoding'], 'UTF-16le')


if __name__ == '__main__':
    unittest.main(verbosity=2)
