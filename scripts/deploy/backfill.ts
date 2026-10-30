import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ClickHouse } from '../../src/lib/clickhouse';
import { expandHome, loadEnvFiles } from '../../src/lib/env';
import { installErrorHandlers, writeOut } from '../../src/lib/egress';
import { verifySessionSchema } from '../../src/lib/session-schema';
import { listJsonl, shipOnce, type ShipRoot } from '../../src/ship/ship';

export const FREE_FLOOR = 35 * 1024 ** 3;
// Match shipOnce's initial --since file selection; plain files still win over compressed twins.
export function inventoryBytes(roots: ShipRoot[], sinceMs: number) {
  return roots.flatMap(root => listJsonl(root.dir, root.kind === 'codex')).reduce((sum, path) => {
    const { size, mtimeMs } = statSync(path);
    if (mtimeMs < sinceMs) return sum;
    if (!path.endsWith('.zst')) return sum + size;
    // -lv sums frame content sizes, including concatenated frames, without decompressing.
    const info = spawnSync('zstd', ['-lv', '--', path], { encoding: 'utf8', timeout: 30_000 });
    const decoded = info.status === 0 ? info.stdout.match(/^Decompressed Size:.*\((\d+) B\)/m)?.[1] : undefined;
    // Unknown frame size / unavailable CLI: conservatively budget 6x compressed bytes.
    return sum + (decoded === undefined ? size * 6 : Number(decoded));
  }, 0);
}
export async function checkSpace(ch: ClickHouse, bytes: number) {
  const [disk] = await ch.queryJSON<{ free_space: string; keep_free_space: string; compressed: string; uncompressed: string }>(`SELECT free_space, keep_free_space,
    (SELECT sum(data_compressed_bytes) FROM system.parts WHERE database='tokenlayer' AND table='session_events' AND active) AS compressed,
    (SELECT sum(data_uncompressed_bytes) FROM system.parts WHERE database='tokenlayer' AND table='session_events' AND active) AS uncompressed
    FROM system.disks WHERE name='default'`);
  if (!disk || [disk.free_space, disk.keep_free_space, disk.compressed, disk.uncompressed].some(v => !/^\d+$/.test(String(v)))) throw Error('cannot measure hub data-volume headroom');
  const free = Number(disk.free_space), reserve = Number(disk.keep_free_space), compressed = Number(disk.compressed), uncompressed = Number(disk.uncompressed);
  // At >= 1 GiB active uncompressed data, projected = decoded inventory * max(observed ratio, 0.30) * 1.25.
  // The ratio floor limits compression credit; 25% covers merge/index overhead. Smaller samples use 2x.
  const factor = uncompressed >= 1024 ** 3 ? Math.max(compressed / uncompressed, 0.30) * 1.25 : 2;
  const projected = Math.ceil(bytes * factor);
  // ClickHouse 26.10 free_space excludes keep_free_space; add it back to count the 35 GiB floor once.
  const realFree = free + reserve;
  if (![free, reserve, realFree, compressed, uncompressed, projected].every(Number.isSafeInteger) || projected < 0 || realFree - projected < FREE_FLOOR) throw Error('backfill refused: hub free space after projected import must be >= 35 GiB');
  return factor;
}
export class BackfillClient extends ClickHouse {
  override async insert(table: string, rows: readonly unknown[], token?: string) {
    // Serialized size also includes derived metadata and escaping, exceeding the source bytes.
    await checkSpace(this, Buffer.byteLength(JSON.stringify(rows)));
    return super.insert(table, rows, token);
  }
}
if (import.meta.main) {
  installErrorHandlers();
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const since = value('--since'), rate = value('--rate-mb');
  const sinceMs = since ? Date.parse(since) : NaN, rateBytesPerSec = rate ? Number(rate) * 1024 ** 2 : NaN;
  if (!Number.isFinite(sinceMs)) throw Error('--since requires a valid date');
  if (!Number.isFinite(rateBytesPerSec) || rateBytesPerSec <= 0) throw Error('--rate-mb requires a finite positive number');
  const env = loadEnvFiles((process.env.TOKENLAYER_ENV_FILES ?? '~/.config/tokenlayer/ship.env:~/.config/tokenlayer/clickhouse.env').split(':'));
  if (!env.TOKENLAYER_MACHINE) throw Error('TOKENLAYER_MACHINE is required');
  const ch = new BackfillClient(ClickHouse.fromEnv(env).config);
  const roots: ShipRoot[] = [
    { kind: 'claude', dir: expandHome(env.TOKENLAYER_CLAUDE_DIR ?? '~/.claude/projects') },
    { kind: 'codex', dir: expandHome(env.TOKENLAYER_CODEX_DIR ?? '~/.codex/sessions') },
  ];
  const bytes = inventoryBytes(roots, sinceMs), factor = await checkSpace(ch, bytes);
  writeOut(`backfill inventory_bytes=${bytes} projected_bytes=${Math.ceil(bytes * factor)}; projected=ceil(decoded_inventory*(uncompressed>=1GiB?max(compressed/uncompressed,0.30)*1.25:2)); floor=35 GiB real free; real_free=free_space+keep_free_space`);
  await verifySessionSchema(ch);
  const result = await shipOnce({ machine: env.TOKENLAYER_MACHINE, roots, clickhouse: ch,
    statePath: expandHome(env.TOKENLAYER_SHIP_STATE ?? join('~/.config/tokenlayer', 'backfill-state.json')),
    sinceMs, rateBytesPerSec });
  writeOut(`backfill files=${result.files} lines=${result.lines} bytes=${result.bytes}`);
}
