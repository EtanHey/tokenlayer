import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifySource, type Source } from '../scripts/history/source';
import { historyFixtureDirectories } from './fixtures/history-temp';

const directory = historyFixtureDirectories('history-source-');
const id = '00000000-0000-4000-8000-000000000064';
const hash = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
type Kind = 'claude' | 'codex';
// Only generated padding: identity deliberately follows byte 65,536 on large records.
function nativeHeader(kind: Kind, bytes: number, ending = '\n') {
    const suffix = kind === 'claude' ? `","sessionId":"${id}"}${ending}` : `","payload":{"id":"${id}"}}${ending}`;
    const start = kind === 'claude' ? '{"padding":"' : '{"type":"session_meta","padding":"';
    return Buffer.from(start + 'x'.repeat(bytes - Buffer.byteLength(start + suffix)) + suffix);
}
const fixture = (raw: Buffer, kind: Kind, compressed = false) => {
    const root = directory(); mkdirSync(join(root, 'roots'));
    const path = join(root, 'roots', (kind === 'claude' ? 'agent-synthetic' : `rollout-${id}`) + '.jsonl' + (compressed ? '.zst' : ''));
    const physical = compressed ? Buffer.from(Bun.zstdCompressSync(raw)) : raw;
    writeFileSync(path, physical);
    const source: Source = { path, kind, sessionId: id, physicalSha256: hash(physical), decodedSha256: hash(raw), decodedBytes: raw.length, prefixBytes: raw.length, prefixSha256: hash(raw) };
    return { source, roots: [{ kind, dir: join(root, 'roots') }] };
};
for (const [kind, compressed] of [['claude', false], ['codex', false], ['codex', true]] as const) {
    for (const [bytes, ending] of [[84726, '\n'], [65536, '\n'], [65537, '\n'], [65537, '\r\n'], [1024 ** 2 + 1, '\n']] as const) {
        test(`${kind} ${compressed ? 'zstd' : 'plain'} accepts complete first record: ${bytes} bytes ${JSON.stringify(ending)}`, async () => {
            const raw = nativeHeader(kind, bytes, ending), f = fixture(raw, kind, compressed);
            expect(raw.length).toBe(bytes);
            const check = await verifySource(f.source, f.roots);
            expect(check.nonemptyLines).toBe(1);
            expect(check.prefixEnds).toEqual([raw.length]);
            expect(check).not.toThrow();
        });
    }
    test(`${kind} ${compressed ? 'zstd' : 'plain'} rejects no LF, over-cap first/later records and mismatched native identity`, async () => {
        for (const raw of [nativeHeader(kind, 84726, ''), nativeHeader(kind, 1024 ** 2 + 2),
            Buffer.concat([nativeHeader(kind, 256), Buffer.from('x'.repeat(1024 ** 2 + 1) + '\n')])]) {
            const f = fixture(raw, kind, compressed);
            await expect(verifySource(f.source, f.roots)).rejects.toThrow(raw.at(-1) === 10 ? 'record exceeds 1 MiB' : 'source pin mismatch');
        }
        const f = fixture(nativeHeader(kind, 84726), kind, compressed);
        await expect(verifySource({ ...f.source, sessionId: 'different-owner' }, f.roots)).rejects.toThrow(`native ${kind === 'claude' ? 'Claude' : 'Codex'} identity mismatch`);
    });
    test(`${kind} ${compressed ? 'zstd' : 'plain'} preserves short header window without scanning later records for ownership`, async () => {
        const header = nativeHeader(kind, 256);
        const f = fixture(Buffer.concat([Buffer.from('{}\n'), header]), kind, compressed);
        await expect(verifySource(f.source, f.roots)).resolves.toBeFunction();
        const late = fixture(Buffer.concat([Buffer.from('{"padding":"' + 'x'.repeat(84726) + '"}\n'), header]), kind, compressed);
        await expect(verifySource(late.source, late.roots)).rejects.toThrow('identity mismatch');
    });
}
