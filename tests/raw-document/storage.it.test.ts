import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { clickhouseBinary, startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { diskVerdict } from '../../src/archaeology/disk-plan';
import { RawDocumentStore } from '../../src/raw-document/storage';

const fs = statfsSync(import.meta.dir);
const capacity = diskVerdict(32 * 1024 ** 2, Math.min(fs.bavail, fs.bfree) * fs.bsize).verdict === 'PASS';
test.skipIf(!capacity || !clickhouseBinary())('isolated CH raw revisions and FINAL replay (unchanged physical floor)', async () => {
  const local = await startLocalClickHouse();
  try {
    await local.client.exec('CREATE DATABASE tokenlayer');
    await local.client.exec(readFileSync(new URL('../../src/raw-document/schema.sql', import.meta.url), 'utf8')
      .replace('{database:Identifier}', '`tokenlayer`').replace(/;\s*$/, ''));
    const store = new RawDocumentStore(local.client);
    const raw = Buffer.from('{\n  "x": "é שלום 🌍"\n}');
    const source = { bytes: raw, originalHash: createHash('sha256').update(raw).digest('hex'), originalBytes: raw.length,
      custodyMachine: 'synthetic', sourceLocator: '/synthetic/a.json', format: 'json', formatVersion: 'UNKNOWN',
      acquisition: { method: 'synthetic', observedAt: '2026-11-06T00:00:00.000Z', receiptHash: 'a'.repeat(64) } };
    await store.put(source); await store.put(source);
    await store.put({ ...source, sourceLocator: '/synthetic/copy.json' });
    const changed = Buffer.concat([raw, Buffer.from('\n')]);
    await store.put({ ...source, bytes: changed, originalBytes: changed.length,
      originalHash: createHash('sha256').update(changed).digest('hex') });
    const rows = await local.client.queryJSON<{ h: string; origin_machine: string }>(
      'SELECT hex(raw) AS h, origin_machine FROM tokenlayer.raw_documents FINAL ORDER BY original_bytes');
    expect(rows.map(r => r.h)).toEqual([raw, raw, changed].map(b => b.toString('hex').toUpperCase()));
    expect(rows.every(r => r.origin_machine === 'UNKNOWN')).toBe(true);
  } finally { await local.stop(); }
}, 40_000);
