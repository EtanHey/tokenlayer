import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClickHouse } from '../../src/lib/clickhouse';
import { shipOnce } from '../../src/ship/ship';
import { loadState } from '../../src/ship/state';
test('allowlist bypasses cutoff only for selected files; cap and stop preserve exact progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'history-options-'));
    const path = join(dir, 'a.jsonl');
    const line = '{"type":"fixture"}\n';
    for (const name of ['a.jsonl', 'b.jsonl']) {
        writeFileSync(join(dir, name), line.repeat(40));
        utimesSync(join(dir, name), 1, 1);
    }
    const client = new ClickHouse({ url: 'unused', user: '', password: '', database: 'tokenlayer' });
    let inserts = 0, stopped = false;
    client.insert = async () => { inserts++; };
    const opts = { machine: 'm4', roots: [{ kind: 'codex' as const, dir }], statePath: join(dir, 'state'),
        clickhouse: client, files: [path], sinceMs: Date.now(), rateBytesPerSec: 0 };
    expect((await shipOnce({ ...opts, maxLines: 32 })).lines).toBe(32);
    expect(loadState(opts.statePath).files[path].offset).toBe(32 * line.length);
    expect(Object.keys(loadState(opts.statePath).files)).toEqual([path]);
    client.insert = async () => { inserts++; stopped = true; };
    expect((await shipOnce({ ...opts, batchBytes: line.length, shouldStop: () => stopped })).lines).toBe(1);
    expect(loadState(opts.statePath).files[path].offset).toBe(33 * line.length);
    expect(inserts).toBe(2);
});
