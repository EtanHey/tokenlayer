import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureClient, render, startServer } from '../../scripts/deploy/deploy';
import { parseEnv } from '../../src/lib/env';
import { ClickHouse } from '../../src/lib/clickhouse';

const GiB = 1024 ** 3;

// The live rollout: the writer user first (tokenlayer still uncapped), then the reader profile, each by a config
// reload on the same server process; ClickHouse is never restarted.
test('reader cap and writer user apply by config reload, without a restart', async () => {
  mkdirSync('.local', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.local/memguard-'));
  const config = join(root, '.config/tokenlayer');
  mkdirSync(join(root, 'Library/Application Support/tokenlayer/clickhouse'), { recursive: true });
  mkdirSync(join(root, 'Library/Logs/tokenlayer'), { recursive: true });
  configureClient('m1', 'http://127.0.0.1:8123', root);
  const ports = [0, 0].map(() => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }));
  const [http, tcp] = ports.map(p => p.port); ports.forEach(p => p.stop(true));
  const final = render(readFileSync('config/clickhouse.xml.template', 'utf8'), { HOME: root })
    .replace('<http_port>8123', `<http_port>${http}`).replace('<tcp_port>19000', `<tcp_port>${tcp}`);
  const stage1 = final.replace(/(<tokenlayer>[\s\S]*?<profile>)reader(<\/profile>)/, '$1default$2');
  expect(stage1).not.toBe(final);
  writeFileSync(join(config, 'clickhouse.xml'), stage1);
  const proc = startServer(Bun.which('clickhouse') ?? 'clickhouse', root);
  try {
    const password = parseEnv(readFileSync(join(config, 'clickhouse.env'), 'utf8')).CLICKHOUSE_PASSWORD!;
    const reader = new ClickHouse({ url: `http://127.0.0.1:${http}`, user: 'tokenlayer', password, database: 'default' });
    const writer = new ClickHouse({ ...reader.config, user: 'tokenlayer_writer' });
    let ready = false;
    for (let i = 0; i < 150 && proc.exitCode === null; i++) {
      try { ready = (await fetch(`${reader.config.url}/ping`)).ok; } catch {}
      if (ready) break;
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    const cap = (ch: ClickHouse) => ch.exec("SELECT getSetting('max_memory_usage')").then(s => Number(s.trim()));
    expect(await cap(reader)).toBe(0);
    expect(await cap(writer)).toBe(0);

    writeFileSync(join(config, 'clickhouse.xml'), final);
    await writer.exec('SYSTEM RELOAD CONFIG');
    expect(proc.exitCode).toBe(null);
    expect(await cap(reader)).toBe(8 * GiB);
    expect(await reader.exec("SELECT getSetting('max_bytes_before_external_sort')").then(Number)).toBe(4 * GiB);
    expect(await cap(writer)).toBe(0);
    // A caller can lower the cap but not lift it, and 0 (unlimited) is refused.
    expect(await reader.exec("SELECT getSetting('max_memory_usage') SETTINGS max_memory_usage=1000000").then(Number)).toBe(1e6);
    for (const v of [0, 16 * GiB]) await expect(reader.exec(`SELECT 1 SETTINGS max_memory_usage=${v}`)).rejects.toThrow('exception 452');
    // The cap binds: a query past it fails with MEMORY_LIMIT_EXCEEDED (lowered cap keeps the test light).
    await expect(reader.exec('SELECT groupArray(number) FROM numbers(50000000) SETTINGS max_memory_usage=50000000')).rejects.toThrow('exception 241');
    expect(await writer.exec('SELECT length(groupArray(number)) FROM numbers(50000000)').then(Number)).toBe(5e7);
  } finally { proc.kill('SIGKILL'); await proc.exited; }
}, 40000);
