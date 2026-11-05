import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { spawnZstd } from '../../src/ship/zst';
import { logicalSessionPath, ownsSessionPath, type ShipRoot } from '../../src/ship/ship';
import { antigravitySession, isAntigravity } from '../../src/ship/antigravity';
import { saveState, type ShipState } from '../../src/ship/state';
export type Source = {
    path: string;
    kind: ShipRoot['kind'];
    sessionId: string;
    physicalSha256: string;
    decodedSha256: string;
    decodedBytes: number;
    prefixBytes: number;
    prefixSha256: string;
};
export type Manifest = {
    machine: string;
    sources: Source[];
};
export const signature = (path: string) => { const s = statSync(path); return `${s.dev}:${s.ino}:${s.birthtimeMs}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; };
/** Verify immutable original-path input in bounded chunks; no decoded payload touches disk. */
export async function verifySource(s: Source, roots: ShipRoot[], shouldStop = () => false) {
    if (!s.sessionId || !roots.some(r => r.kind === s.kind && s.path.startsWith(realpathSync(r.dir) + sep)) || realpathSync(s.path) !== s.path || !ownsSessionPath(s.path, s.kind === 'codex'))
        throw Error('source ownership/path unresolved');
    if (![s.physicalSha256, s.decodedSha256, s.prefixSha256].every(h => /^[a-f0-9]{64}$/.test(h)) ||
        ![s.decodedBytes, s.prefixBytes].every(n => Number.isSafeInteger(n) && n > 0) || s.prefixBytes > s.decodedBytes || s.decodedBytes > 64 * 1024 ** 3)
        throw Error('invalid source pins');
    const root = roots.find(r => r.kind === s.kind && s.path.startsWith(realpathSync(r.dir) + sep))!;
    if (isAntigravity(s.kind) && antigravitySession(root.dir, s.path, s.kind) !== s.sessionId)
        throw Error('native Antigravity identity mismatch');
    const before = signature(s.path), full = createHash('sha256'), prefix = createHash('sha256');
    const proc = s.path.endsWith('.zst') ? spawnZstd(s.path) : undefined;
    const stream = proc?.stdout ?? createReadStream(s.path);
    let size = 0, lineBytes = 0, first: Buffer[] = [], headBytes = 0, last = -1, prefixLast = -1;
    const prefixEnds: number[] = [];
    try {
        for await (const value of stream) {
            if (shouldStop())
                throw Error('history stopped during source verification');
            const chunk = Buffer.from(value);
            for (let i = 0; i < chunk.length; i++) {
                const c = chunk[i];
                lineBytes = c === 10 ? 0 : lineBytes + 1;
                if (c === 10 && size + i < s.prefixBytes) {
                    prefixEnds.push(size + i + 1);
                    if (prefixEnds.length > 4096)
                        throw Error('prefix metadata cap');
                }
                if (lineBytes > 1024 ** 2)
                    throw Error('history record exceeds 1 MiB');
            }
            full.update(chunk);
            if (size < s.prefixBytes) {
                const part = chunk.subarray(0, s.prefixBytes - size);
                prefix.update(part);
                prefixLast = part.at(-1)!;
            }
            if (headBytes < 65536) {
                const part = chunk.subarray(0, 65536 - headBytes);
                first.push(part);
                headBytes += part.length;
            }
            size += chunk.length;
            last = chunk.at(-1)!;
        }
        if (proc && await proc.exited !== 0)
            throw Error('source decode failed');
    }
    finally {
        if (proc) {
            proc.kill();
            await proc.exited;
        }
    }
    const physical = createHash('sha256');
    for await (const chunk of createReadStream(s.path)) {
        if (shouldStop())
            throw Error('history stopped during physical verification');
        physical.update(chunk);
    }
    if (before !== signature(s.path) || size !== s.decodedBytes || last !== 10 || prefixLast !== 10 || full.digest('hex') !== s.decodedSha256 || prefix.digest('hex') !== s.prefixSha256 || physical.digest('hex') !== s.physicalSha256 || before !== signature(s.path))
        throw Error('source pin mismatch or mutation');
    // Native UUID header and filename agree; no attribution from the custody directory alone.
    const head = Buffer.concat(first).toString('utf8').split('\n').slice(0, -1);
    if (s.kind === 'codex' && (!basename(s.path).includes(s.sessionId) || !head.some(l => { try {
        const o = JSON.parse(l);
        return o.type === 'session_meta' && o.payload?.id === s.sessionId;
    }
    catch {
        return false;
    } })))
        throw Error('native Codex identity mismatch');
    if (s.kind === 'claude' && !head.some(l => { try {
        return JSON.parse(l).sessionId === s.sessionId;
    }
    catch {
        return false;
    } }))
        throw Error('native Claude identity mismatch');
    return Object.assign(() => { if (signature(s.path) !== before)
        throw Error('source mutated during import'); }, { prefixEnds });
}
/** Read live files without loadState's legacy-upgrade side effect. Seed only owned lineage. */
export function seedLineage(source: Source, statePath: string, livePaths: string[]) {
    const path = logicalSessionPath(source.path);
    const checkpoints = livePaths.flatMap(p => [p, `${p}.generations`]).filter(existsSync).flatMap(p => {
        if (statSync(p).size > 32 * 1024 ** 2)
            throw Error('lineage scratch cap');
        const s = JSON.parse(readFileSync(p, 'utf8')) as ShipState;
        if (s.version !== 3)
            throw Error('legacy lineage needs reconciliation');
        return s.files[path] ? [s.files[path]] : [];
    });
    if (new Set(checkpoints.map(c => c.generation)).size > 1)
        throw Error('conflicting original generations');
    if (existsSync(`${statePath}.generations`)) {
        const s = JSON.parse(readFileSync(`${statePath}.generations`, 'utf8')) as ShipState;
        if (checkpoints.some(c => s.files[path] && s.files[path].generation !== c.generation))
            throw Error('import/live generation conflict');
        return;
    }
    const cp = checkpoints.sort((a, b) => b.offset - a.offset)[0];
    if (cp)
        saveState(`${statePath}.generations`, { version: 3, files: { [path]: cp } });
}
