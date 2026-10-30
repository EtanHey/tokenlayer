import { expect, test } from 'bun:test';
import { statfsSync } from 'node:fs';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { applySchema } from '../../src/lib/schema';
import { BackfillClient, checkSpace, FREE_FLOOR } from '../../scripts/deploy/backfill';

test('real ClickHouse free_space and unreserved_space exclude keep_free_space exactly once', async () => {
  for (const keepFreeSpaceBytes of [0, FREE_FLOOR]) {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes });
    try {
      await applySchema(local.client);
      const [disk] = await local.client.queryJSON<{ path: string; free_space: string; unreserved_space: string; keep_free_space: string }>(
        "SELECT path, free_space, unreserved_space, keep_free_space FROM system.disks WHERE name='default'");
      const fs = statfsSync(disk.path), realFree = fs.bavail * fs.bsize;
      expect(Number(disk.keep_free_space)).toBe(keepFreeSpaceBytes);
      expect(Math.abs(realFree - Number(disk.free_space) - keepFreeSpaceBytes)).toBeLessThan(16 * 1024 ** 2);
      expect(Number(disk.unreserved_space)).toBe(Number(disk.free_space));
      console.info(JSON.stringify({ version: await local.client.exec('SELECT version()'), ...disk, realFree }));
      expect(await checkSpace(local.client, 1)).toBe(2);
      const ch = new BackfillClient(local.client.config);
      await ch.exec('CREATE TABLE tokenlayer.backfill_probe (n UInt8) ENGINE=Memory');
      await ch.insert('backfill_probe', [{ n: 42 }]);
      expect(await ch.queryJSON('SELECT n FROM tokenlayer.backfill_probe')).toEqual([{ n: 42 }]);
    } finally { await local.stop(); }
  }
}, 80_000);
