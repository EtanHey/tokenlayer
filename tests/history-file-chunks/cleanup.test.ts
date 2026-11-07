import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { acquireFile, statPin, type Receipt } from '../../src/history-file-chunks/acquire';
import { custodyOps } from '../../src/metadata/private-fs';

for (const phase of ['precommit', 'postcommit'] as const) test(`outer close fault ${phase} preserves primary/result and attempts all anchors`, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.FILE_CHUNKS_TEST_ROOT ?? tmpdir(), `cleanup-${phase}-`)));
  const path = join(dir, 'source'), out = join(dir, 'out'), bytes = Buffer.from('owned-close-fixture');
  fs.writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const spec = { path, custodyMachine: 'synthetic', sourceFormat: 'opaque-file', wholeBytes: bytes.length,
    wholeHash: phase === 'precommit' ? '0'.repeat(64) : sha(bytes), stat: statPin(fs.lstatSync(path, { bigint: true })),
    method: 'owned-close-fault', observedAt: '2026-11-07T00:00:00.000Z', evidenceHash: 'c'.repeat(64) };
  const originalOpen = custodyOps.open, originalClose = fs.closeSync, live = new Set<number>();
  let source = -1, injected = false, opens = 0, closes = 0, spaceCalls = 0;
  const free = spyOn(custodyOps, 'free').mockImplementation(() => { spaceCalls++; return 64 * 1024 ** 3; }); // Synthetic space only.
  const open = spyOn(custodyOps, 'open').mockImplementation((fd, name, flags, mode) => {
    const n = originalOpen(fd, name, flags, mode); live.add(n); opens++; if (name === 'source') source = n; return n;
  });
  const close = spyOn(fs, 'closeSync').mockImplementation(fd => {
    originalClose(fd); if (live.delete(fd)) closes++;
    if (fd === source && !injected) { injected = true; throw Error('SYNTHETIC_CLOSE_PRIVATE_SENTINEL'); }
  });
  let value: Receipt | undefined, error = '';
  try { value = acquireFile(spec, out); } catch (e) { error = (e as Error).message; }
  finally { close.mockRestore(); open.mockRestore(); free.mockRestore(); }
  const skipped = [...live], published = fs.existsSync(join(out, 'manifest.json'));
  // Record the implementation outcome before reclaiming only this control's skipped owned descriptors.
  fs.writeFileSync(join(dir, 'observation.json'), JSON.stringify({ phase, error, returned: !!value, published,
    injected, opens, syntheticSpaceCalls: spaceCalls, cleanupAttempts: closes, skippedAnchorCloses: skipped.length, sourceUnchanged: sha(fs.readFileSync(path)) === sha(bytes) }) + '\n', { flag: 'wx', mode: 0o600 });
  for (const fd of skipped) originalClose(fd);
  if (phase === 'precommit') expect(spaceCalls).toBe(0); else expect(spaceCalls).toBeGreaterThan(0);
  expect(injected).toBe(true); expect(error).not.toContain('SYNTHETIC_CLOSE_PRIVATE_SENTINEL');
  if (phase === 'precommit') { expect(error).toBe('FILE_CHUNKS_WHOLE_PIN'); expect(published).toBe(false); expect(value).toBeUndefined(); }
  else { expect(error).toBe(''); expect(value).toEqual(JSON.parse(fs.readFileSync(join(out, 'manifest.json'), 'utf8'))); expect(value?.manifest.acquisitionComplete).toBe(true); }
  expect(skipped).toHaveLength(0); expect(closes).toBe(opens); expect(fs.readFileSync(path)).toEqual(bytes);
});
