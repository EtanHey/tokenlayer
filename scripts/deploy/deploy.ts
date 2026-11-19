import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnvFiles, parseEnv } from '../../src/lib/env';
import { ClickHouse } from '../../src/lib/clickhouse';
import { replaceService, withPausedSidecars } from './launchd';
import { installErrorHandlers } from '../../src/lib/egress';

const repo = resolve(import.meta.dir, '../..');
const home = homedir();
const config = join(home, '.config/tokenlayer');
const logs = join(home, 'Library/Logs/tokenlayer');
function run(command: string[], env = process.env) {
  const r = spawnSync(command[0], command.slice(1), { cwd: repo, env, stdio: 'inherit' });
  if (r.status !== 0) throw Error(`deploy command failed: ${command[0]}`);
}
export function render(template: string, values: Record<string, string>): string {
  const xml = template.replace(/__([A-Z]+)__/g, (_, name: string) => {
    // execPath resolves Homebrew symlinks into the upgrade-sensitive Cellar.
    const value = name === 'BUN' ? '/opt/homebrew/bin/bun' : values[name];
    if (value === undefined) throw Error(`unresolved placeholder ${name}`);
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  });
  if (xml.includes('/Cellar/')) throw Error('refusing versioned Cellar path in rendered config');
  return xml;
}
function privateFile(path: string, tighten = false) {
  const st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid!()) throw Error('env must be an owned regular file');
  if (tighten) chmodSync(path, 0o600);
  if (!tighten && (st.mode & 0o777) !== 0o600) throw Error('env must be an owned regular file with mode 600');
}
export const writerEnv = 'clickhouse-writer.env';
// Generated into a pipe, never argv or a log.
function newPassword() {
  const r = spawnSync('openssl', ['rand', '-hex', '32'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || !/^[a-f0-9]{64}\n$/.test(r.stdout)) throw Error('password generation failed');
  return r.stdout.trim();
}
export function configureClient(machine: 'm1' | 'm4', url: string, root = home) {
  if (machine === 'm1' ? url !== 'http://127.0.0.1:8123' : !/^https:\/\/[a-z0-9.-]+\.ts\.net:8123$/.test(url)) throw Error('invalid ClickHouse endpoint');
  const dir = join(root, '.config/tokenlayer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid!()) throw Error('config must be an owned directory');
  chmodSync(dir, 0o700);
  const path = join(dir, 'clickhouse.env');
  if (!existsSync(path)) {
    if (machine === 'm4') throw Error('copy clickhouse.env from M1 first (see runbook)');
    writeFileSync(path, `CLICKHOUSE_PASSWORD=${newPassword()}\nCLICKHOUSE_USER=tokenlayer\nCLICKHOUSE_DB=tokenlayer\n`, { mode: 0o600, flag: 'wx' });
  }
  privateFile(path, true);
  const reader = parseEnv(readFileSync(path, 'utf8')).CLICKHOUSE_PASSWORD ?? '';
  if (!/^[a-f0-9]{64}$/.test(reader)) throw Error('invalid password file; keep it and investigate');
  // The uncapped writer (ship, drain) has its own password, so the reader's cannot open it.
  const writerPath = join(dir, writerEnv);
  if (!existsSync(writerPath)) {
    if (machine === 'm4') throw Error(`copy ${writerEnv} from M1 first: copy-password.sh <m1-host> ${writerEnv}`);
    writeFileSync(writerPath, `CLICKHOUSE_USER=tokenlayer_writer\nCLICKHOUSE_PASSWORD=${newPassword()}\n`, { mode: 0o600, flag: 'wx' });
  }
  privateFile(writerPath, true);
  const writer = parseEnv(readFileSync(writerPath, 'utf8'));
  if (writer.CLICKHOUSE_USER !== 'tokenlayer_writer' || !/^[a-f0-9]{64}$/.test(writer.CLICKHOUSE_PASSWORD ?? '')) throw Error('invalid writer password file; keep it and investigate');
  if (writer.CLICKHOUSE_PASSWORD === reader) throw Error('the writer password must differ from the reader password');
  if (existsSync(join(dir, 'ship.env'))) privateFile(join(dir, 'ship.env'), true);
  writeFileSync(join(dir, 'ship.env'), `TOKENLAYER_MACHINE=${machine}\nCLICKHOUSE_URL=${url}\nCLICKHOUSE_USER=tokenlayer\nCLICKHOUSE_DB=tokenlayer\n`, { mode: 0o600 });
  chmodSync(join(dir, 'ship.env'), 0o600);
}
const clientEnv = () => loadEnvFiles([join(config, 'ship.env'), join(config, 'clickhouse.env')], {});
/** Schema apply is DDL, which the reader profile refuses: it logs in as the writer (clickhouse-writer.env last wins). */
const writerClientEnv = () => loadEnvFiles([join(config, 'ship.env'), join(config, 'clickhouse.env'), join(config, writerEnv)], {});
async function install(label: string, machine: string, binary = '') {
  const agents = join(home, 'Library/LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const target = join(agents, `${label}.plist`);
  writeFileSync(target, render(readFileSync(join(repo, `launchd/${label}.plist.template`), 'utf8'), { HOME: home, REPO: repo, MACHINE: machine, CLICKHOUSE: binary }));
  run(['plutil', '-lint', target]);
  await replaceService(label, target);
}
export function backfillArgs(days: number, rate: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || !Number.isFinite(rate) || rate <= 0 || rate > 5) throw Error('use --days positive integer and --rate-mb in (0,5]');
  return ['--backfill', '--since', new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10), '--rate-mb', String(rate)];
}
/** The server config: the writer's hash is rendered into the mode-600 file, so a reload applies it (the reader's comes from the server env). */
export function clickhouseConfig(root = home) {
  const dir = join(root, '.config/tokenlayer');
  privateFile(join(dir, writerEnv));
  const password = parseEnv(readFileSync(join(dir, writerEnv), 'utf8')).CLICKHOUSE_PASSWORD;
  if (!password) throw Error('missing ClickHouse writer password');
  return render(readFileSync(join(repo, 'config/clickhouse.xml.template'), 'utf8'), { HOME: root, WRITERHASH: createHash('sha256').update(password).digest('hex') });
}
/** Write the config (old file kept in backups/), then reload it on the running server: no restart. */
export async function applyConfig(root: string, reader: ClickHouse, xml = clickhouseConfig(root)) {
  const dir = join(root, '.config/tokenlayer');
  const target = join(dir, 'clickhouse.xml');
  mkdirSync(join(dir, 'backups'), { recursive: true, mode: 0o700 });
  if (existsSync(target)) copyFileSync(target, join(dir, 'backups', `clickhouse.xml.${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`), constants.COPYFILE_EXCL);
  writeFileSync(join(dir, '.clickhouse.xml.new'), xml, { mode: 0o600, flag: 'wx' });
  renameSync(join(dir, '.clickhouse.xml.new'), target);
  await reader.exec('SYSTEM RELOAD CONFIG');
  const writer = parseEnv(readFileSync(join(dir, writerEnv), 'utf8'));
  await new ClickHouse({ ...reader.config, user: writer.CLICKHOUSE_USER!, password: writer.CLICKHOUSE_PASSWORD! }).exec('SELECT 1');
}
export function startServer(binary: string, root = home) {
  privateFile(join(root, '.config/tokenlayer', 'clickhouse.env'));
  const env = parseEnv(readFileSync(join(root, '.config/tokenlayer', 'clickhouse.env'), 'utf8'));
  const password = env.CLICKHOUSE_PASSWORD;
  if (!password) throw Error('missing ClickHouse password');
  const proc = Bun.spawn([binary, 'server', `--config-file=${join(root, '.config/tokenlayer', 'clickhouse.xml')}`], { env: { ...process.env, CLICKHOUSE_WATCHDOG_ENABLE: '0', CLICKHOUSE_PASSWORD_SHA256: createHash('sha256').update(password).digest('hex') }, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  return proc;
}
if (import.meta.main) {
  installErrorHandlers();
  process.umask(0o077);
  const [action, ...args] = process.argv.slice(2);
  const required = action === 'hub' ? ['openssl', 'plutil', 'launchctl', 'tailscale'] : action === 'ship' ? ['plutil', 'launchctl'] : [];
  for (const binary of required) if (!Bun.which(binary)) throw Error(`${binary} missing from PATH; no changes made`);
  mkdirSync(logs, { recursive: true });
  if (action === 'hub') {
    configureClient('m1', 'http://127.0.0.1:8123');
    await withPausedSidecars(async () => {
      mkdirSync(join(home, 'Library/Application Support/tokenlayer/clickhouse'), { recursive: true, mode: 0o700 });
      writeFileSync(join(config, 'clickhouse.xml'), clickhouseConfig(), { mode: 0o600 });
      await install('com.tokenlayer.clickhouse', 'm1', args[0]);
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try { ready = (await fetch('http://127.0.0.1:8123/ping', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
        if (ready) break;
        await Bun.sleep(500);
      }
      if (!ready) throw Error('ClickHouse /ping did not become ready');
      run([process.execPath, 'run', 'schema:apply'], { ...process.env, ...writerClientEnv() });
      run(['tailscale', 'serve', '--bg', '--https=8123', 'http://127.0.0.1:8123']);
    });
  } else if (action === 'ship') {
    if (args[0] !== 'm1' && args[0] !== 'm4') throw Error('ship m1 | ship m4 https://hub.ts.net:8123');
    configureClient(args[0], args[0] === 'm1' ? 'http://127.0.0.1:8123' : args[1]);
    await ClickHouse.fromEnv(clientEnv()).exec('SELECT 1 FROM tokenlayer.v_sessions_daily LIMIT 0');
    if (args[0] === 'm1') {
      privateFile(join(config, 'hub.env'), true);
      if (!parseEnv(readFileSync(join(config, 'hub.env'), 'utf8')).CLIPROXY_MGMT_KEY) throw Error('hub.env missing management key');
      await install('com.tokenlayer.drain', 'm1');
    }
    await install('com.tokenlayer.ship', args[0]);
  } else if (action === 'config') {
    // M1 only: apply a changed clickhouse.xml.template (or a new writer password) without restarting ClickHouse.
    configureClient('m1', 'http://127.0.0.1:8123');
    await applyConfig(home, ClickHouse.fromEnv(clientEnv()));
  } else if (action === 'server') {
    const proc = startServer(args[0]);
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => proc.kill(sig));
    process.exit(await proc.exited);
  } else if (action === 'backfill') {
    if (args.some((arg, i) => i % 2 === 0 && !['--days', '--rate-mb'].includes(arg)) || args.length % 2) throw Error('backfill --days 90 [--rate-mb 2]');
    const value = (flag: string, fallback: number) => args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : fallback;
    const flags = backfillArgs(value('--days', 90), value('--rate-mb', 2));
    // Separate progress avoids a daemon/backfill checkpoint race; FINAL replacement keys deduplicate.
    const state = join(config, 'backfill-state.json');
    const proc = Bun.spawn([process.execPath, 'scripts/deploy/backfill.ts', ...flags], { cwd: repo, env: { ...process.env, TOKENLAYER_SHIP_STATE: state }, stdout: Bun.file(join(logs, 'backfill.log')), stderr: Bun.file(join(logs, 'backfill.err.log')) });
    process.exit(await proc.exited);
  } else throw Error('usage: setup.sh hub | config | ship m1 | ship m4 https://hub.ts.net:8123');
}
