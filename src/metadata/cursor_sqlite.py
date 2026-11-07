"""Bounded SQLite logical cells, NOT a whole-DB snapshot or production importer."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
from datetime import datetime, timezone
from urllib.parse import quote

FORMAT = 'cursor-sqlite-logical-cells-v1'
OUTPUT = Path.home() / '.config/tokenlayer/history-intake'
CAPS = dict(rows=100000, total_bytes=64 * 1024**2, value_bytes=16 * 1024**2, seconds=30)
PROFILES = ('default', 'ide-512mib-v1')
FLOOR = 20 * 1024**3
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Refusal(Exception):
    def __init__(self, code, output=None):
        super().__init__(code)
        self.code, self.output = code, output


def require(ok, code):
    if not ok:
        raise Refusal(code)


def packed(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(st):
    return (st.st_dev, st.st_ino, stat.S_IFMT(st.st_mode))


def directory(path, create=False):
    """Walk absolute components with nofollow, retaining a descriptor to the final directory."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'PATH')
    fd = os.open('/', FLAGS)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def acquire(source, run, *, pending_bytes, profile='default', _after_snapshot=None, **options):
    """Returns metadata only. Complete cells are streamed privately; hooks are synthetic-only."""
    require(type(profile) is str and profile in PROFILES, 'PROFILE')
    maxima = CAPS if profile == 'default' else CAPS | dict(total_bytes=512 * 1024**2, seconds=180)
    limits = maxima | options
    require(set(limits) == set(maxima), 'LIMITS')
    for key, maximum in maxima.items():
        value = limits[key]
        require(type(value) in (int, float) and 0 < value <= maximum and math.isfinite(value)
                and (key == 'seconds' or type(value) is int), 'LIMITS')
    require(type(pending_bytes) is int and 0 <= pending_bytes <= 2**60, 'LIMITS')
    require(isinstance(run, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,100}', run), 'RUN')
    source = Path(source)
    require(source.is_absolute() and '..' not in source.parts and len(str(source)) <= 4096, 'PATH')
    started = time.monotonic()
    deadline = started + limits['seconds']
    observed = datetime.now(timezone.utc).isoformat()
    counts = dict(selected=0, retained=0, held=0, tombstone=0, invalid=0)
    total = written = 0
    selection, stream_hash = hashlib.sha256(), hashlib.sha256()
    # Maximum base64 expansion plus bounded escaped key/metadata overhead per row.
    reserve = 2 * limits['total_bytes'] + 8192 * limits['rows'] + 65536
    root = out = parent = pin = cells = None
    con = None
    output_path = None

    def clock():
        require(time.monotonic() < deadline, 'TIME_LIMIT')

    def space():
        v = os.fstatvfs(out)
        require(v.f_bavail * v.f_frsize >= FLOOR + pending_bytes + max(0, reserve - written), 'SPACE')

    def write_file(name, content):
        nonlocal written
        clock()
        require(written + len(content) <= reserve, 'OUTPUT_LIMIT')
        space()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=out)
        with os.fdopen(fd, 'wb') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        written += len(content)

    def path_pin():
        # Rewalk ancestors as well as checking the anchored entry and held descriptor.
        current = directory(source.parent)
        try:
            require(identity(os.fstat(current)) == identity(os.fstat(parent)), 'SOURCE_CHANGED')
            st = os.stat(source.name, dir_fd=current, follow_symlinks=False)
            require(identity(st) == identity(os.fstat(pin)) and st.st_nlink > 0, 'SOURCE_CHANGED')
            for suffix, previous in sidecars.items():
                try:
                    now = os.stat(source.name + suffix, dir_fd=current, follow_symlinks=False)
                except FileNotFoundError:
                    now = None
                require((identity(now) if now else None) == previous, 'SOURCE_CHANGED')
        finally:
            os.close(current)

    try:
        root = directory(OUTPUT, create=True)
        rs = os.fstat(root)
        require(rs.st_uid == os.getuid() and stat.S_IMODE(rs.st_mode) == 0o700, 'PRIVATE_OUTPUT')
        os.mkdir(run, 0o700, dir_fd=root)  # Fresh, exclusive; never reuse another run.
        out = os.open(run, FLAGS, dir_fd=root)
        output_path = str(OUTPUT / run)
        write_file('partial.json', packed(dict(status='PARTIAL', format=FORMAT, observedAt=observed)))
        parent = directory(source.parent)
        pin = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        require(stat.S_ISREG(os.fstat(pin).st_mode), 'SOURCE_TYPE')
        header = os.pread(pin, 100, 0)
        require(header[:16] == b'SQLite format 3\x00' and len(header) == 100, 'SCHEMA')
        sidecars = {}
        for suffix in ('-wal', '-shm'):
            try:
                st = os.stat(source.name + suffix, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                st = None
            require(st is None or stat.S_ISREG(st.st_mode), 'SOURCE_SYMLINK')
            sidecars[suffix] = identity(st) if st else None
        require(not (header[18] == 2 or sidecars['-wal'])
                or bool(sidecars['-wal'] and sidecars['-shm']), 'WAL_MISSING_SIDECARS')
        path_pin()
        con = sqlite3.connect('file:' + quote(str(source), safe='/') + '?mode=ro&cache=private',
                              uri=True, timeout=min(1, limits['seconds']), isolation_level=None)
        con.set_progress_handler(lambda: int(time.monotonic() >= deadline), 100)
        con.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, CAPS['value_bytes'] + 8192)
        con.execute('PRAGMA query_only=ON')
        con.execute('PRAGMA cache_size=-2048')
        con.execute('PRAGMA temp_store=MEMORY')
        con.execute('BEGIN')
        # The first schema read pins the WAL-aware SQLite transaction snapshot.
        schema = con.execute("SELECT type,CASE WHEN length(CAST(sql AS BLOB))<=8192 THEN sql END FROM sqlite_schema WHERE name='cursorDiskKV'").fetchmany(2)
        require(len(schema) == 1 and schema[0][0] == 'table'
                and isinstance(schema[0][1], str) and not re.search(r'\bVIRTUAL\b', schema[0][1], re.I), 'SCHEMA')
        columns = con.execute('PRAGMA table_xinfo(cursorDiskKV)').fetchmany(3)
        require([(x[1], x[2].upper(), x[6]) for x in columns]
                == [('key', 'TEXT', 0), ('value', 'BLOB', 0)], 'SCHEMA')
        indexes = con.execute('PRAGMA index_list(cursorDiskKV)').fetchmany(33)
        require(len(indexes) <= 32, 'SCHEMA')
        unique = False
        for idx in indexes:
            if idx[2] and not idx[4]:
                info = con.execute('PRAGMA index_xinfo(' + '"' + idx[1].replace('"', '""') + '")').fetchmany(33)
                keys = [x for x in info if x[5]]
                unique |= len(info) <= 32 and len(keys) == 1 and keys[0][2] == 'key' and keys[0][4] == 'BINARY'
        require(unique, 'SCHEMA')
        encoding = con.execute('PRAGMA encoding').fetchone()[0]
        require(encoding in ('UTF-8', 'UTF-16le', 'UTF-16be'), 'ENCODING')
        if _after_snapshot:
            _after_snapshot()
        path_pin()
        cells_fd = os.open('cells.ndjson', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                           0o600, dir_fd=out)
        cells = os.fdopen(cells_fd, 'wb')
        for prefix in ('bubbleId', 'composerData'):
            # BLOB-key lookalikes are invalid, not silently omitted as a complete selection.
            bad = con.execute('SELECT 1 FROM cursorDiskKV WHERE key COLLATE BINARY>=? AND key COLLATE BINARY<? LIMIT 1',
                              ((prefix + ':').encode(), (prefix + ';').encode())).fetchone()
            require(bad is None, 'KEY_TYPE')
            # CASE protects fetch byte caps; no entire oversized value crosses into Python.
            query = '''SELECT CASE WHEN length(CAST(key AS BLOB))<=1024 THEN key END,
                typeof(key), typeof(value), length(CAST(value AS BLOB)),
                CASE WHEN length(CAST(value AS BLOB))<=? THEN CAST(value AS BLOB) END
                FROM cursorDiskKV WHERE key COLLATE BINARY>=? AND key COLLATE BINARY<? ORDER BY key COLLATE BINARY'''
            # Fetch one row at a time so the remaining total-byte cap is enforced in SQL.
            last = prefix + ':'
            inclusive = True
            while True:
                clock()
                path_pin()
                bound = min(limits['value_bytes'], limits['total_bytes'] - total)
                if counts['selected'] >= limits['rows']:
                    bound = 0  # Probe existence only, never fetch a value past the row budget.
                sql = query.replace('BINARY>=?', 'BINARY>=?' if inclusive else 'BINARY>?') + ' LIMIT 1'
                row = con.execute(sql, (bound, last, prefix + ';')).fetchone()
                if row is None:
                    break
                key, key_type, value_type, size, raw = row
                require(key_type == 'text' and isinstance(key, str) and key.startswith(prefix + ':'), 'KEY')
                counts['selected'] += 1
                require(counts['selected'] <= limits['rows'], 'ROW_LIMIT')
                status = 'NULL' if size is None else 'JSON'
                failure = None
                if size is not None and size > bound:
                    status = 'OVERSIZE' if size > limits['value_bytes'] else 'BYTE_LIMIT'
                    failure = status
                    counts['held'] += 1
                elif raw is None:
                    counts['tombstone'] += 1
                else:
                    counts['retained'] += 1
                    total += size
                    try:
                        codec = {'UTF-8': 'utf-8', 'UTF-16le': 'utf-16-le', 'UTF-16be': 'utf-16-be'}[encoding]
                        # BLOB JSON has no SQLite text encoding; explicitly require UTF-8.
                        value = json.loads(raw.decode(codec if value_type == 'text' else 'utf-8'),
                                           parse_int=str, parse_float=str,
                                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                        if value is None:
                            status = 'JSON_NULL'
                            counts['tombstone'] += 1
                    except (ValueError, RecursionError):
                        status = 'INVALID_JSON'
                        counts['invalid'] += 1
                        counts['held'] += 1
                meta = dict(key=key, keyType=key_type, sqliteType=value_type, sqliteEncoding=encoding, bytes=size,
                            sha256=digest(raw) if raw is not None else None, status=status)
                cell_digest = digest(packed(meta))
                selection.update(packed(meta) + b'\n')
                replay = digest(packed([FORMAT, os.uname().nodename, str(source), cell_digest]))
                line = packed(meta | dict(cellDigest=cell_digest, replayId=replay,
                                         valueBase64=base64.b64encode(raw).decode() if raw is not None else None)) + b'\n'
                require(written + len(line) <= reserve, 'OUTPUT_LIMIT')
                space()
                cells.write(line)
                written += len(line)
                stream_hash.update(line)
                if failure:
                    raise Refusal(failure)
                last, inclusive = key, False
        clock()
        path_pin()
        cells.flush()
        os.fsync(cells.fileno())
        cells.close()
        cells = None
        con.execute('ROLLBACK')
        con.close()
        con = None
        path_pin()
        current = directory(OUTPUT)
        try:
            require(identity(os.fstat(current)) == identity(os.fstat(root))
                    and identity(os.stat(run, dir_fd=current, follow_symlinks=False)) == identity(os.fstat(out)), 'OUTPUT_CHANGED')
        finally:
            os.close(current)
        manifest = dict(status='COMPLETE_WITH_HOLDS' if counts['held'] else 'COMPLETE', format=FORMAT,
                        formatVersion=1, method='readonly-sqlite-transaction-logical-cells', observedAt=observed,
                        sourceLocator=str(source), sourceIdentity=identity(os.fstat(pin)), output=output_path,
                        counts=counts, retainedBytes=total, profile=profile, limits=limits, pendingBytes=pending_bytes,
                        selectionDigest=selection.hexdigest(), cellsSha256=stream_hash.hexdigest(),
                        custodyMachine=os.uname().nodename, table='cursorDiskKV', sqliteVersion=sqlite3.sqlite_version,
                        keyRanges=[['bubbleId:', 'bubbleId;'], ['composerData:', 'composerData;']],
                        sourceConsistency='SQLITE_READ_TRANSACTION',
                        originMachine='UNKNOWN', account='UNKNOWN', nativeOrT3='UNKNOWN',
                        snapshotCompleteness='NOT_ACQUIRED', eventTime='NOT_INFERRED')
        write_file('manifest.pending', packed(manifest))
        clock()
        path_pin()
        os.fsync(out)
        # This no-overwrite publication is the commit point; no fallible writes follow it.
        os.link('manifest.pending', 'manifest.json', src_dir_fd=out, dst_dir_fd=out, follow_symlinks=False)
        return manifest
    except BaseException as error:
        code = error.code if isinstance(error, Refusal) else 'SQLITE_OR_IO_REFUSAL'
        if isinstance(error, sqlite3.Error) and getattr(error, 'sqlite_errorcode', None) in (5, 6):
            code = 'SQLITE_LOCKED'
        if isinstance(error, sqlite3.Error) and getattr(error, 'sqlite_errorcode', None) == 18:
            code = 'SQLITE_LENGTH_LIMIT'
        if time.monotonic() >= deadline:
            code = 'TIME_LIMIT'
        if out is not None:
            # Bypass expired deadline/floor only for this tiny adverse receipt. No exception text.
            try:
                fd = os.open('failure.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=out)
                with os.fdopen(fd, 'wb') as f:
                    f.write(packed(dict(status='PARTIAL', code=code, counts=counts, retainedBytes=total)))
                    f.flush()
                    os.fsync(f.fileno())
            except OSError:
                pass  # The initial partial receipt remains; never publish success on failure.
        raise Refusal(code, output_path) from None
    finally:
        # Cleanup cannot replace a sanitized primary refusal or undo publication.
        # Data flush/fsync/close before publication remain in the guarded body.
        cleanup_failed = False
        for resource in (cells, con):
            if resource is not None:
                try:
                    resource.close()
                except BaseException:
                    cleanup_failed = True
        for fd in (pin, parent, out, root):
            if fd is not None:
                try:
                    os.close(fd)
                except BaseException:
                    cleanup_failed = True
        if cleanup_failed:
            try:
                os.write(2, b'CURSOR_CLEANUP_WARNING\n')
            except BaseException:
                pass


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--pending-bytes', type=int, required=True)
    parser.add_argument('--profile', default='default', help='default (64MiB/30s) or ide-512mib-v1 (512MiB/180s)')
    args = parser.parse_args()
    try:
        result = acquire(Path(args.source), args.run, pending_bytes=args.pending_bytes, profile=args.profile)
        print(json.dumps({k: result[k] for k in ('status', 'counts', 'selectionDigest', 'cellsSha256')}))
    except Refusal as error:
        print(json.dumps(dict(status='REFUSED', code=error.code)))
        raise SystemExit(1)
