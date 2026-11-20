import { expect } from 'bun:test';
import { test } from '../support/clickhouse-gate';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyConfig, clickhouseConfig, configureClient, startServer } from '../../scripts/deploy/deploy';
import { parseEnv } from '../../src/lib/env';
import { ClickHouse } from '../../src/lib/clickhouse';

const GiB = 1024 ** 3;
// R4's writer: the same password source as the reader.
const sharedHash = '<password_sha256_hex from_env="CLICKHOUSE_PASSWORD_SHA256" hide_in_preprocessed="true"/>';

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
  const final = clickhouseConfig(root)
    .replace('<http_port>8123', `<http_port>${http}`).replace('<tcp_port>19000', `<tcp_port>${tcp}`);
  const stage1 = final.replace(/(<tokenlayer>[\s\S]*?<profile>)reader(<\/profile>)/, '$1default$2');
  expect(stage1).not.toBe(final);
  writeFileSync(join(config, 'clickhouse.xml'), stage1);
  const proc = startServer(Bun.which('clickhouse') ?? 'clickhouse', root);
  try {
    const password = parseEnv(readFileSync(join(config, 'clickhouse.env'), 'utf8')).CLICKHOUSE_PASSWORD!;
    const reader = new ClickHouse({ url: `http://127.0.0.1:${http}`, user: 'tokenlayer', password, database: 'default' });
    const writerEnv = parseEnv(readFileSync(join(config, 'clickhouse-writer.env'), 'utf8'));
    const writer = new ClickHouse({ ...reader.config, user: 'tokenlayer_writer', password: writerEnv.CLICKHOUSE_PASSWORD! });
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
    // The temp-disk limit holds the same way (security pre-review S1: 0 was accepted, i.e. unlimited spill).
    expect(await reader.exec("SELECT getSetting('max_temporary_data_on_disk_size_for_query') SETTINGS max_temporary_data_on_disk_size_for_query=1000000").then(Number)).toBe(1e6);
    for (const v of [0, 16 * GiB]) await expect(reader.exec(`SELECT 1 SETTINGS max_temporary_data_on_disk_size_for_query=${v}`)).rejects.toThrow('exception 452');
    // The cap binds: a query past it fails with MEMORY_LIMIT_EXCEEDED (lowered cap keeps the test light).
    await expect(reader.exec('SELECT groupArray(number) FROM numbers(50000000) SETTINGS max_memory_usage=50000000')).rejects.toThrow('exception 241');
    expect(await writer.exec('SELECT length(groupArray(number)) FROM numbers(50000000)').then(Number)).toBe(5e7);
  } finally { proc.kill('SIGKILL'); await proc.exited; }
}, 40000);

// R6: the uncapped writer gets its own password by a config reload. Before, the reader's password opened it.
test('the writer password moves off the reader password by config reload, without a restart', async () => {
  mkdirSync('.local', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.local/writerpw-'));
  const config = join(root, '.config/tokenlayer');
  const data = join(root, 'Library/Application Support/tokenlayer/clickhouse');
  mkdirSync(data, { recursive: true });
  mkdirSync(join(root, 'Library/Logs/tokenlayer'), { recursive: true });
  configureClient('m1', 'http://127.0.0.1:8123', root);
  const ports = [0, 0].map(() => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }));
  const [http, tcp] = ports.map(p => p.port); ports.forEach(p => p.stop(true));
  const local = (xml: string) => xml.replace('<http_port>8123', `<http_port>${http}`).replace('<tcp_port>19000', `<tcp_port>${tcp}`);
  const r4 = local(clickhouseConfig(root)).replace(/<password_sha256_hex hide_in_preprocessed="true">[a-f0-9]{64}<\/password_sha256_hex>/, sharedHash);
  expect(r4).not.toBe(local(clickhouseConfig(root)));
  writeFileSync(join(config, 'clickhouse.xml'), r4, { mode: 0o600 });
  const proc = startServer(Bun.which('clickhouse') ?? 'clickhouse', root);
  try {
    const readerPassword = parseEnv(readFileSync(join(config, 'clickhouse.env'), 'utf8')).CLICKHOUSE_PASSWORD!;
    const writerEnv = parseEnv(readFileSync(join(config, 'clickhouse-writer.env'), 'utf8'));
    const reader = new ClickHouse({ url: `http://127.0.0.1:${http}`, user: 'tokenlayer', password: readerPassword, database: 'default' });
    const readerAsWriter = new ClickHouse({ ...reader.config, user: 'tokenlayer_writer' });
    const writer = new ClickHouse({ ...reader.config, user: writerEnv.CLICKHOUSE_USER!, password: writerEnv.CLICKHOUSE_PASSWORD! });
    let ready = false;
    for (let i = 0; i < 150 && proc.exitCode === null; i++) {
      try { ready = (await fetch(`${reader.config.url}/ping`)).ok; } catch {}
      if (ready) break;
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    // R4's gap: the reader's password logs in uncapped.
    expect(await readerAsWriter.exec("SELECT getSetting('max_memory_usage')").then(Number)).toBe(0);
    await expect(writer.exec('SELECT 1')).rejects.toThrow('exception 516');

    const pid = proc.pid;
    await applyConfig(root, reader, local(clickhouseConfig(root)));
    expect(proc.exitCode).toBe(null);
    expect(proc.pid).toBe(pid);
    await expect(readerAsWriter.exec('SELECT 1')).rejects.toThrow('exception 516');
    expect(await writer.exec("SELECT getSetting('max_memory_usage')").then(Number)).toBe(0);
    expect(await reader.exec("SELECT getSetting('max_memory_usage')").then(Number)).toBe(8 * GiB);
    // The old file is kept, private; the new one is private too.
    const backups = readdirSync(join(config, 'backups')).filter(n => n.startsWith('clickhouse.xml.'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(config, 'backups', backups[0]), 'utf8')).toBe(r4);
    for (const f of [join(config, 'backups', backups[0]), join(config, 'clickhouse.xml')]) expect(statSync(f).mode & 0o777).toBe(0o600);
    // Neither password nor the writer hash reaches the preprocessed copy.
    const processed = readFileSync(join(data, 'preprocessed_configs/clickhouse.xml'), 'utf8');
    const writerHash = createHash('sha256').update(writerEnv.CLICKHOUSE_PASSWORD!).digest('hex');
    for (const secret of [readerPassword, writerEnv.CLICKHOUSE_PASSWORD!, writerHash]) expect(processed.includes(secret)).toBe(false);
  } finally { proc.kill('SIGKILL'); await proc.exited; }
}, 40000);
