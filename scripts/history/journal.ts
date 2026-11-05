import { closeSync, createReadStream, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const STATE_CAP = 64 * 1024 ** 2;
export function privateSize(path: string) {
    let s;
    try { s = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
    if (!s.isFile() || (s.mode & 0o077)) throw Error('unsafe importer state file');
    return s.size;
}
const syncDir = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
/** Immutable audit segments plus an atomically replaced, bounded active file. Single writer only. */
export class AuditLog {
    constructor(readonly path: string, readonly cap = STATE_CAP) {
        if (!Number.isSafeInteger(cap) || cap < 1024 || cap > STATE_CAP) throw Error('invalid active state cap');
    }
    size() { return privateSize(this.path); }
    shared() { return this.size() > 0 && lstatSync(this.path).nlink > 1; }
    rotate(retain: unknown[] = []) {
        if (!this.size()) return;
        const next = this.path + '.next', audit = join(dirname(this.path), 'audit');
        privateSize(next);
        mkdirSync(audit, { recursive: true, mode: 0o700 });
        if (realpathSync(audit) !== audit || (lstatSync(audit).mode & 0o077)) throw Error('unsafe audit directory');
        syncDir(dirname(this.path)); // Persist a newly created audit directory before replacing active history.
        const bytes = retain.map(r => JSON.stringify(r) + '\n').join('');
        if (Buffer.byteLength(bytes) > this.cap) throw Error('unresolved history exceeds active cap');
        const fd = openSync(next, 'w', 0o600);
        try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        // Link the old inode before replacing it. Never append to a linked active inode:
        // after a crash before rename, reconcile rotates it again before any append.
        linkSync(this.path, join(audit, `${basename(this.path, '.ndjson')}.${randomUUID()}.ndjson`));
        syncDir(audit);
        renameSync(next, this.path);
        syncDir(dirname(this.path));
    }
    append(record: unknown) {
        const bytes = JSON.stringify(record) + '\n';
        if (this.shared() || this.size() + Buffer.byteLength(bytes) > this.cap) throw Error('active history log requires reconciliation/rotation');
        const fd = openSync(this.path, 'a', 0o600);
        try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        syncDir(dirname(this.path));
    }
    receipt(record: unknown) {
        const size = this.size();
        if (size) {
            const fd = openSync(this.path, 'r'), last = Buffer.alloc(1);
            try { readSync(fd, last, 0, 1, size - 1); } finally { closeSync(fd); }
            if (last[0] !== 10) throw Error('torn history receipt; retain for reconciliation');
        }
        const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (bytes > this.cap) throw Error('single history receipt exceeds cap');
        if (this.shared() || this.size() + bytes > this.cap) this.rotate();
        this.append(record);
    }
    /** Stream legacy cumulative ledgers too; bound each record rather than total audit bytes. */
    async *records() {
        if (!this.size()) return;
        let carry = Buffer.alloc(0);
        for await (const chunk of createReadStream(this.path)) {
            carry = Buffer.concat([carry, chunk]);
            let nl: number;
            while ((nl = carry.indexOf(10)) >= 0) {
                if (nl > STATE_CAP) throw Error('history ledger record exceeds cap');
                if (nl) yield JSON.parse(carry.subarray(0, nl).toString('utf8'));
                carry = carry.subarray(nl + 1);
            }
            if (carry.length > STATE_CAP) throw Error('history ledger record exceeds cap');
        }
        if (carry.length) throw Error('torn history ledger; reconcile retained intent before resuming');
    }
}
