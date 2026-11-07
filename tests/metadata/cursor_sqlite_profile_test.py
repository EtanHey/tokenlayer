"""Closed profiles: tiny owned WAL source, isolated HOME, synthetic output space."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'src/metadata/cursor_sqlite.py'
SPEC = importlib.util.spec_from_file_location('profile_reader', SOURCE)
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)
IDE = 'ide-512mib-v1'


class ProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = ROOT / '.local/cursor-sqlite-tests' / ('profile-' + uuid.uuid4().hex)
        cls.fixture.mkdir(mode=0o700, parents=True)
        cls.db, cls.records = cls.fixture / 'owned.db', []
        cls.writer = sqlite3.connect(cls.db)
        cls.writer.execute('PRAGMA journal_mode=WAL')
        cls.writer.execute('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB)')
        cls.writer.executemany('INSERT INTO cursorDiskKV VALUES (?,?)',
                              [('bubbleId:owned', b'{"clock":null,"tokens":0}'), ('composerData:owned', None)])
        cls.writer.commit()
        site = cls.fixture / 'sitecustomize.py'
        site.write_text('import os\nfrom types import SimpleNamespace\nos.fstatvfs=lambda _:SimpleNamespace(f_bavail=24*1024**3,f_frsize=1)\n')
        site.chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.writer.close()
        receipt = cls.fixture / 'profile-controls.json'
        receipt.write_text(json.dumps(cls.records, indent=2, sort_keys=True) + '\n')
        receipt.chmod(0o600)

    def call(self, **options):
        run = self.fixture.name + '-' + uuid.uuid4().hex
        try:
            result = reader.acquire(self.db, run, pending_bytes=options.pop('pending_bytes', 0), **options)
            self.records.append({k: result[k] for k in ('status', 'output', 'limits', 'selectionDigest')})
            return result
        except reader.Refusal as error:
            self.records.append(dict(status='REFUSED', code=error.code, output=error.output))
            raise

    def test_explicit_profile_manifest_and_stable_cells(self):
        with patch.object(reader.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=24*1024**3, f_frsize=1)):
            default, explicit, ide = self.call(), self.call(profile='default'), self.call(profile=IDE)
            lower = self.call(profile=IDE, total_bytes=64*1024**2+1, seconds=31)
        for result, name, total, seconds in [(default, 'default', 64*1024**2, 30),
                (explicit, 'default', 64*1024**2, 30), (ide, IDE, 512*1024**2, 180)]:
            self.assertEqual(result['profile'], name)
            self.assertEqual(result['limits'], dict(rows=100000, total_bytes=total, value_bytes=16*1024**2, seconds=seconds))
            self.assertEqual(json.loads((Path(result['output']) / 'manifest.json').read_text())['profile'], name)
            self.assertEqual((Path(result['output']) / 'cells.ndjson').read_bytes(),
                             (Path(default['output']) / 'cells.ndjson').read_bytes())
        self.assertEqual(lower['limits']['seconds'], 31)  # Acceptance of a bound, not a 31s runtime claim.
        self.assertEqual(lower['limits']['total_bytes'], 64*1024**2+1)

    def test_invalid_profiles_and_budgets_before_output(self):
        cases = [(dict(profile=x), 'PROFILE') for x in ('unknown', None, [])] + [
            (dict(total_bytes=64*1024**2+1), 'LIMITS'), (dict(seconds=31), 'LIMITS'),
            (dict(profile=IDE, total_bytes=512*1024**2+1), 'LIMITS'), (dict(profile=IDE, seconds=181), 'LIMITS'),
            (dict(profile=IDE, seconds=float('nan')), 'LIMITS'), (dict(profile=IDE, seconds=float('inf')), 'LIMITS'),
            (dict(profile=IDE, rows=100001), 'LIMITS'), (dict(profile=IDE, value_bytes=16*1024**2+1), 'LIMITS'),
            (dict(profile=IDE, timeout=180), 'LIMITS'),
            (dict(profile=IDE, rows=True), 'LIMITS'), (dict(profile=IDE, pending_bytes=-1), 'LIMITS')]
        with patch.object(reader, 'directory', side_effect=AssertionError('OUTPUT_MUST_NOT_OPEN')) as opened:
            for options, code in cases:
                with self.subTest(code=code, kind=type(options.get('profile')).__name__), self.assertRaises(reader.Refusal) as raised:
                    self.call(**options)
                self.assertEqual((raised.exception.code, raised.exception.output), (code, None))
            opened.assert_not_called()

    def test_lowered_byte_gate_under_selected_profile(self):
        with patch.object(reader.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=24*1024**3, f_frsize=1)):
            with self.assertRaises(reader.Refusal) as raised:
                self.call(profile=IDE, total_bytes=2)
            self.assertEqual(raised.exception.code, 'BYTE_LIMIT')
            self.assertFalse((Path(raised.exception.output) / 'manifest.json').exists())
            self.assertEqual(self.call(profile=IDE, rows=2, total_bytes=64, value_bytes=64, seconds=1)['retainedBytes'], 25)

    def test_full_selected_envelope_and_pending_floor(self):
        pending = 1234
        reserve = 2*(512*1024**2) + 8192*100000 + 65536
        available = reader.FLOOR + pending + reserve
        with patch.object(reader.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=available-1, f_frsize=1)):
            self.assertEqual(self.call(pending_bytes=pending)['status'], 'COMPLETE')
            with self.assertRaises(reader.Refusal) as raised:
                self.call(profile=IDE, pending_bytes=pending)
            self.assertEqual(raised.exception.code, 'SPACE')
        with patch.object(reader.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=available, f_frsize=1)):
            self.assertEqual(self.call(profile=IDE, pending_bytes=pending)['status'], 'COMPLETE')
        with patch.object(reader.os, 'fstatvfs', side_effect=[SimpleNamespace(f_bavail=available, f_frsize=1),
                SimpleNamespace(f_bavail=reader.FLOOR+pending-1, f_frsize=1)]):
            with self.assertRaises(reader.Refusal) as raised:
                self.call(profile=IDE, pending_bytes=pending)
            self.assertEqual(raised.exception.code, 'SPACE')  # Space is rechecked after the initial receipt.
            self.assertFalse((Path(raised.exception.output) / 'manifest.json').exists())

    def test_actual_cli_default_explicit_and_unknown(self):
        for profile in (None, 'default', IDE, 'unknown'):
            with self.subTest(profile=profile):
                run = self.fixture.name + '-cli-' + uuid.uuid4().hex
                args = [sys.executable, '-B', str(SOURCE), '--source', str(self.db), '--run', run, '--pending-bytes', '0']
                if profile is not None:
                    args += ['--profile', profile]
                result = subprocess.run(args, capture_output=True, timeout=5,
                                        env=os.environ | dict(PYTHONPATH=str(self.fixture), PYTHONDONTWRITEBYTECODE='1'))
                self.records.append(dict(cliProfile=profile, exitCode=result.returncode,
                                         stdout=result.stdout.decode(), stderr=result.stderr.decode()))
                self.assertEqual(result.stderr, b'')
                self.assertEqual(result.returncode, 1 if profile == 'unknown' else 0)
                output = reader.OUTPUT / run
                if profile == 'unknown':
                    self.assertEqual(json.loads(result.stdout), dict(status='REFUSED', code='PROFILE'))
                    self.assertFalse(output.exists())
                else:
                    manifest = json.loads((output / 'manifest.json').read_text())
                    self.assertEqual(manifest['profile'], profile or 'default')
                    self.assertEqual(manifest['limits']['total_bytes'], (512 if profile == IDE else 64)*1024**2)
                    self.assertEqual(manifest['limits']['seconds'], 180 if profile == IDE else 30)
