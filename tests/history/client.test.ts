import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingHistoryClient, RESERVE, MARGIN } from '../../scripts/history/stream';
test('headroom charges reserve, margin and existing reservations exactly once; unknown fails closed', async () => {
    const client = new StreamingHistoryClient({ url: 'unused', user: '', password: '', database: 'tokenlayer' }, { ledger: join(mkdtempSync(join(tmpdir(), 'history-guard-')), 'ledger'), manifest: 'fixture', run: 'fixture', sessionId: 'native' });
    const allocation = 12345;
    const query = spyOn(client, 'queryJSON');
    for (const reserve of [0, RESERVE]) {
        const free = RESERVE - reserve + MARGIN + allocation;
        query.mockResolvedValue([{ free_space: String(free), unreserved_space: String(free), keep_free_space: String(reserve) }] as any);
        await expect(client.headroom(allocation)).resolves.toBeUndefined();
        query.mockResolvedValue([{ free_space: String(free), unreserved_space: String(free - 1), keep_free_space: String(reserve) }] as any);
        await expect(client.headroom(allocation)).rejects.toThrow('history low space');
    }
    for (const row of [{}, { free_space: 'unknown' }, { free_space: '9007199254740992', unreserved_space: '0', keep_free_space: '0' }]) {
        query.mockResolvedValue([row] as any);
        await expect(client.headroom(allocation)).rejects.toThrow('unknown or stale');
    }
    query.mockRestore();
});
