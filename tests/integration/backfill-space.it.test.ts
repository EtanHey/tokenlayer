import { expect, spyOn, test } from 'bun:test';
import { statfsSync } from 'node:fs';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { applySchema } from '../../src/lib/schema';
import { BackfillClient, checkSpace, FREE_FLOOR } from '../../scripts/deploy/backfill';

// Observe the real query used by the operation, rather than racing a separate disk sample.
async function expectBudgetDecision(ch: BackfillClient, bytes: number, run: () => Promise<unknown>, expected?: unknown) {
  const query = spyOn(ch, 'queryJSON');
  try {
    const result = run();
    await Promise.allSettled([result]);
    expect(query).toHaveBeenCalledTimes(1);
    const [disk] = await query.mock.results[0].value as Record<string, unknown>[];
    expect(Number(disk.uncompressed)).toBe(0); // Empty fixture uses the 2x projection.
    const allows = Number(disk.free_space) + Number(disk.keep_free_space) - 2 * bytes >= FREE_FLOOR;
    if (allows) expect(await result).toBe(expected);
    else await expect(result).rejects.toThrow('backfill refused: hub free space after projected import must be >= 35 GiB');
    return allows;
  } finally { query.mockRestore(); }
}

test('real ClickHouse free_space and unreserved_space exclude keep_free_space exactly once', async () => {
  const initial = statfsSync(import.meta.dir);
  // Keep a non-saturated accounting case even on hosts below the manual-backfill floor.
  const accountingReserve = Math.min(FREE_FLOOR, Math.floor(initial.bavail * initial.bsize / 2));
  for (const keepFreeSpaceBytes of new Set([0, accountingReserve, FREE_FLOOR])) {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes });
    try {
      await applySchema(local.client);
      const [disk] = await local.client.queryJSON<{ path: string; free_space: string; unreserved_space: string; keep_free_space: string }>(
        "SELECT path, free_space, unreserved_space, keep_free_space FROM system.disks WHERE name='default'");
      const fs = statfsSync(disk.path), realFree = fs.bavail * fs.bsize;
      expect(Number(disk.keep_free_space)).toBe(keepFreeSpaceBytes);
      // ClickHouse saturates at zero when the reserve exceeds the filesystem's free space.
      expect(Math.abs(Math.max(0, realFree - keepFreeSpaceBytes) - Number(disk.free_space))).toBeLessThan(16 * 1024 ** 2);
      expect(Number(disk.unreserved_space)).toBe(Number(disk.free_space));
      console.info(JSON.stringify({ version: await local.client.exec('SELECT version()'), ...disk, realFree }));
      const ch = new BackfillClient(local.client.config);
      await expectBudgetDecision(ch, 1, () => checkSpace(ch, 1), 2);
      await ch.exec('CREATE TABLE tokenlayer.backfill_probe (n UInt8) ENGINE=Memory');
      const rows = [{ n: 42 }];
      const inserted = await expectBudgetDecision(ch, Buffer.byteLength(JSON.stringify(rows)), () => ch.insert('backfill_probe', rows));
      expect(await ch.queryJSON('SELECT n FROM tokenlayer.backfill_probe')).toEqual(inserted ? rows : []);
    } finally { await local.stop(); }
  }
}, 80_000);
