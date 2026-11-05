import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { historyFixtureDirectories } from './fixtures/history-temp';
import { verifySource, type Source } from '../scripts/history/source';
import { readCompleteLines } from '../src/ship/tail';
import { inspectZstd, readZstd } from '../src/ship/zst';
const temp = historyFixtureDirectories('large-record-'), MiB = 1024 ** 2, cap = 16 * MiB;
const sid = '00000000-0000-4000-8000-000000000813';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const header = Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id: sid } }) + '\n');
function blob(bytes: number, lf = true) {
    const start = '{"type":"response_item","payload":{"type":"function_call","arguments":"';
    const end = '"}}' + (lf ? '\n' : '');
    return Buffer.from(start + 'x'.repeat(bytes - Buffer.byteLength(start + end)) + end);
}
function fixture(raw: Buffer, compressed: boolean) {
    const root = temp(); mkdirSync(join(root, 'roots'));
    const path = join(root, 'roots', `rollout-${sid}.jsonl${compressed ? '.zst' : ''}`);
    const physical = compressed ? Buffer.from(Bun.zstdCompressSync(raw)) : raw;
    writeFileSync(path, physical);
    const source: Source = { path, kind: 'codex', sessionId: sid, physicalSha256: hash(physical), decodedSha256: hash(raw), decodedBytes: raw.length, prefixBytes: raw.length, prefixSha256: hash(raw) };
    return { source, roots: [{ kind: 'codex' as const, dir: join(root, 'roots') }] };
}
for (const compressed of [false, true]) {
    test(`explicit history cap accepts 12 MiB tool arguments at LF813 (${compressed ? 'zstd' : 'plain'})`, async () => {
        const prefix = Buffer.concat([header, Buffer.from('{}\n'.repeat(811))]);
        const big = blob(12 * MiB), raw = Buffer.concat([prefix, big, Buffer.from('{}\n')]);
        const f = fixture(raw, compressed);
        const check = await verifySource(f.source, f.roots, undefined, cap);
        expect(check.nonemptyLines).toBe(814); expect(check).not.toThrow();
        await expect(verifySource(f.source, f.roots)).rejects.toThrow('record exceeds 1 MiB');
        const batches = compressed ? readZstd(f.source.path, prefix.length, 65536, undefined, undefined, cap) :
            [readCompleteLines(f.source.path, prefix.length, 65536, cap)];
        let seen = false;
        for await (const b of batches) for (const l of b.lines) if (l.bytes === big.length) {
            expect(l.offset).toBe(prefix.length); expect(hash(b.raw.subarray(l.offset - (b.nextOffset - b.raw.length), l.offset - (b.nextOffset - b.raw.length) + l.bytes))).toBe(hash(big)); seen = true;
        }
        expect(seen).toBe(true);
    });
    test(`exact cap, cap+1, incomplete LF and boundary (${compressed ? 'zstd' : 'plain'})`, async () => {
        for (const [n, lf, accept] of [[cap + 1, true, true], [cap + 2, true, false], [cap, false, false]] as const) {
            const raw = Buffer.concat([header, blob(n, lf)]), f = fixture(raw, compressed);
            if (accept) await expect(verifySource(f.source, f.roots, undefined, cap)).resolves.toBeFunction();
            else await expect(verifySource(f.source, f.roots, undefined, cap)).rejects.toThrow(lf ? 'record exceeds 16 MiB' : 'source pin mismatch');
            const read = async () => {
                if (compressed) { for await (const _ of readZstd(f.source.path, header.length, 65536, undefined, undefined, cap)) {} }
                else readCompleteLines(f.source.path, header.length, 65536, cap);
            };
            if (lf && !accept) await expect(read()).rejects.toThrow('record exceeds 16 MiB');
            else await expect(read()).resolves.toBeUndefined();
        }
        const raw = Buffer.concat([header, blob(65536), blob(65537)]), f = fixture(raw, compressed);
        await expect(verifySource(f.source, f.roots, undefined, cap)).resolves.toBeFunction();
    });
    test(`default reader refuses large records (${compressed ? 'zstd' : 'plain'})`, async () => {
        const f = fixture(blob(2 * MiB), compressed);
        const read = async () => {
            if (compressed) { await inspectZstd(f.source.path, 0); for await (const _ of readZstd(f.source.path, 0, 65536)) {} }
            else readCompleteLines(f.source.path, 0, 65536);
        };
        await expect(read()).rejects.toThrow('record exceeds 1 MiB');
    });
}
test('genuine corrupt zstd remains a decoder error', async () => {
    const f = fixture(header, true); writeFileSync(f.source.path, 'synthetic corrupt frame');
    await expect(inspectZstd(f.source.path, 0, undefined, cap)).rejects.toThrow('zstd decode failed');
});
test('primary record cap survives decoder cleanup failure; genuine exit remains distinct', async () => {
    const spawn = (() => ({ stdout: new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(2 * MiB, 120)); c.close(); } }),
        exited: Promise.resolve(9), kill() { throw Error('synthetic cleanup failure'); } })) as any;
    await expect(inspectZstd('synthetic', 0, spawn)).rejects.toThrow('record exceeds 1 MiB');
    const read = async () => { for await (const _ of readZstd('synthetic', 0, 65536, spawn)) {} };
    await expect(read()).rejects.toThrow('record exceeds 1 MiB');
    const corrupt = (() => ({ stdout: new ReadableStream({ start(c) { c.enqueue(header); c.close(); } }),
        exited: Promise.resolve(9), kill() {} })) as any;
    await expect(inspectZstd('synthetic', 0, corrupt)).rejects.toThrow('zstd decode failed');
});
