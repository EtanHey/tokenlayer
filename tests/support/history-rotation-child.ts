// Isolated failpoint: kill the actual process immediately around the atomic rename.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
const originalRename = fs.renameSync;
const { ledger, pending, phase } = JSON.parse(process.argv[2]);
mock.module('node:fs', () => ({ ...fs, renameSync: (from: string, to: string) => {
    if (from === ledger + '.next' && phase === 'before') process.kill(process.pid, 'SIGKILL');
    originalRename(from, to);
    if (from === ledger + '.next' && phase === 'after') process.kill(process.pid, 'SIGKILL');
} }));
const { AuditLog } = await import('../../scripts/history/journal');
new AuditLog(ledger).rotate([pending]);
throw Error('rotation failpoint did not fire');
