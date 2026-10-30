import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureClient, render, startServer } from '../../scripts/deploy/deploy';
import { parseEnv } from '../../src/lib/env';
import { ClickHouse } from '../../src/lib/clickhouse';
import { checkSpace } from '../../scripts/deploy/backfill';
import { applySchema } from '../../src/lib/schema';

test('deploy config serves authenticated queries, refuses default, hides auth in preprocessed config', async () => {
  mkdirSync('.local', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.local/config-'));
  const config = join(root, '.config/tokenlayer');
  const data = join(root, 'Library/Application Support/tokenlayer/clickhouse');
  mkdirSync(data, { recursive: true }); mkdirSync(join(root, 'Library/Logs/tokenlayer'), { recursive: true });
  configureClient('m1', 'http://127.0.0.1:8123', root);
  const ports = [0, 0].map(() => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }));
  const [http, tcp] = ports.map(p => p.port); ports.forEach(p => p.stop(true));
  const template = readFileSync('config/clickhouse.xml.template', 'utf8');
  writeFileSync(join(config, 'clickhouse.xml'), render(template, { HOME: root }).replace('<http_port>8123', `<http_port>${http}`).replace('<tcp_port>19000', `<tcp_port>${tcp}`));
  const proc = startServer(Bun.which('clickhouse') ?? 'clickhouse', root);
  try {
    const password = parseEnv(readFileSync(join(config, 'clickhouse.env'), 'utf8')).CLICKHOUSE_PASSWORD;
    const ch = new ClickHouse({ url: `http://127.0.0.1:${http}`, user: 'tokenlayer', password, database: 'tokenlayer' });
    let ready = false;
    for (let i = 0; i < 150 && proc.exitCode === null; i++) {
      try { ready = (await fetch(`${ch.config.url}/ping`)).ok; } catch {}
      if (ready) break;
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    await applySchema(ch);
    expect(await ch.queryJSON('SELECT 42 AS n')).toEqual([{ n: 42 }]);
    await expect(checkSpace(ch, Number.MAX_SAFE_INTEGER)).rejects.toThrow('35 GiB');
    await expect(new ClickHouse({ ...ch.config, user: 'default', password: '' }).exec('SELECT 1')).rejects.toThrow();
    await expect(new ClickHouse({ ...ch.config, password: 'wrong-synthetic' }).exec('SELECT 1')).rejects.toThrow();
    const processed = readFileSync(join(data, 'preprocessed_configs/clickhouse.xml'), 'utf8');
    expect(processed.includes(password)).toBe(false);
    expect(processed).not.toContain('<password_sha256_hex');
    expect(template).toContain('<listen_host>127.0.0.1</listen_host>');
    const listeners = spawnSync('lsof', ['-nP', '-a', '-p', String(proc.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    expect(listeners.status).toBe(0);
    expect(listeners.stdout.split('\n').filter(line => line.startsWith('n')).sort()).toEqual([`n127.0.0.1:${http}`, `n127.0.0.1:${tcp}`].sort());
    expect(await ch.queryJSON('SELECT keep_free_space FROM system.disks WHERE name=\'default\'')).toEqual([{ keep_free_space: 35 * 1024 ** 3 }]);
  } finally { proc.kill('SIGKILL'); await proc.exited; }
}, 40000);
