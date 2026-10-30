import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ClickHouse } from '../../src/lib/clickhouse';
import { expandHome, loadEnvFiles } from '../../src/lib/env';
import { installErrorHandlers, writeOut } from '../../src/lib/egress';
import { verifySessionSchema } from '../../src/lib/session-schema';
import { listJsonl, shipOnce, type ShipRoot } from '../../src/ship/ship';

export const FREE_FLOOR = 35 * 1024 ** 3;
// Count all JSONL (including checkpoint replays), conservatively exceeding the mtime-selected subset.
export function inventoryBytes(roots: ShipRoot[]) {
  return roots.flatMap(root => listJsonl(root.dir)).reduce((sum, path) => sum + statSync(path).size, 0);
}
export async function checkSpace(ch: ClickHouse, bytes: number) {
  const [disk] = await ch.queryJSON<{ free_space: string; compressed: string; uncompressed: string }>(`SELECT free_space,
    (SELECT sum(data_compressed_bytes) FROM system.parts WHERE database='tokenlayer' AND table='session_events' AND active) AS compressed,
    (SELECT sum(data_uncompressed_bytes) FROM system.parts WHERE database='tokenlayer' AND table='session_events' AND active) AS uncompressed
    FROM system.disks WHERE name='default'`);
  if (!disk || [disk.free_space, disk.compressed, disk.uncompressed].some(v => !/^\d+$/.test(String(v)))) throw Error('cannot measure hub data-volume headroom');
  const free = Number(disk.free_space), compressed = Number(disk.compressed), uncompressed = Number(disk.uncompressed);
  // 2x for row/index/merge overhead; do not credit compression savings from an unrepresentative sample.
  const factor = 2 * Math.max(1, uncompressed > 0 ? compressed / uncompressed : 1);
  const projected = Math.ceil(bytes * factor);
  if (![free, compressed, uncompressed, projected].every(Number.isSafeInteger) || projected < 0 || free - projected < FREE_FLOOR) throw Error('backfill refused: hub free space after projected import must be >= 35 GiB');
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
  const env = loadEnvFiles((process.env.TOKENLAYER_ENV_FILES ?? '~/.config/tokenlayer/ship.env:~/.config/tokenlayer/clickhouse.env').split(':'));
  if (!env.TOKENLAYER_MACHINE) throw Error('TOKENLAYER_MACHINE is required');
  const ch = new BackfillClient(ClickHouse.fromEnv(env).config);
  const roots: ShipRoot[] = [
    { kind: 'claude', dir: expandHome(env.TOKENLAYER_CLAUDE_DIR ?? '~/.claude/projects') },
    { kind: 'codex', dir: expandHome(env.TOKENLAYER_CODEX_DIR ?? '~/.codex/sessions') },
  ];
  const args = process.argv.slice(2);
  const bytes = inventoryBytes(roots), factor = await checkSpace(ch, bytes);
  writeOut(`backfill inventory_bytes=${bytes} projected_bytes=${Math.ceil(bytes * factor)}; projected=ceil(inventory_bytes*2*max(1,observed_compressed/uncompressed)); reserve=35 GiB`);
  await verifySessionSchema(ch);
  const result = await shipOnce({ machine: env.TOKENLAYER_MACHINE, roots, clickhouse: ch,
    statePath: expandHome(env.TOKENLAYER_SHIP_STATE ?? join('~/.config/tokenlayer', 'backfill-state.json')),
    sinceMs: Date.parse(args[args.indexOf('--since') + 1]),
    rateBytesPerSec: Number(args[args.indexOf('--rate-mb') + 1]) * 1024 ** 2 });
  writeOut(`backfill files=${result.files} lines=${result.lines} bytes=${result.bytes}`);
}
