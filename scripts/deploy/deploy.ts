import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnvFiles, parseEnv } from '../../src/lib/env';
import { ClickHouse } from '../../src/lib/clickhouse';
import { installErrorHandlers } from '../../src/lib/egress';

const repo = resolve(import.meta.dir, '../..');
const home = homedir();
const config = join(home, '.config/tokenlayer');
const logs = join(home, 'Library/Logs/tokenlayer');
const domain = `gui/${process.getuid!()}`;
function run(command: string[], env = process.env) {
  const r = spawnSync(command[0], command.slice(1), { cwd: repo, env, stdio: 'inherit' });
  if (r.status !== 0) throw Error(`deploy command failed: ${command[0]}`);
}
export function render(template: string, values: Record<string, string>): string {
  return template.replace(/__([A-Z]+)__/g, (_, name: string) => {
    if (values[name] === undefined) throw Error(`unresolved placeholder ${name}`);
    return values[name].replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  });
}
function privateFile(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o600) throw Error('env must be an owned regular file with mode 600');
}
export function configureClient(machine: 'm1' | 'm4', url: string, root = home) {
  if (machine === 'm1' ? url !== 'http://127.0.0.1:8123' : !/^https:\/\/[a-z0-9.-]+\.ts\.net:8123$/.test(url)) throw Error('invalid ClickHouse endpoint');
  const dir = join(root, '.config/tokenlayer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'clickhouse.env');
  if (!existsSync(path)) {
    if (machine === 'm4') throw Error('copy clickhouse.env from M1 first (see runbook)');
    const r = spawnSync('openssl', ['rand', '-hex', '32'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0 || !/^[a-f0-9]{64}\n$/.test(r.stdout)) throw Error('password generation failed');
    writeFileSync(path, `CLICKHOUSE_PASSWORD=${r.stdout}CLICKHOUSE_USER=tokenlayer\nCLICKHOUSE_DB=tokenlayer\n`, { mode: 0o600, flag: 'wx' });
  }
  privateFile(path);
  if (!/^[a-f0-9]{64}$/.test(parseEnv(readFileSync(path, 'utf8')).CLICKHOUSE_PASSWORD ?? '')) throw Error('invalid password file; keep it and investigate');
  writeFileSync(join(dir, 'ship.env'), `TOKENLAYER_MACHINE=${machine}\nCLICKHOUSE_URL=${url}\nCLICKHOUSE_USER=tokenlayer\nCLICKHOUSE_DB=tokenlayer\n`, { mode: 0o600 });
  chmodSync(join(dir, 'ship.env'), 0o600);
}
const clientEnv = () => loadEnvFiles([join(config, 'ship.env'), join(config, 'clickhouse.env')], {});
function install(label: string, machine: string, binary = '') {
  const agents = join(home, 'Library/LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const target = join(agents, `${label}.plist`);
  writeFileSync(target, render(readFileSync(join(repo, `launchd/${label}.plist.template`), 'utf8'), { HOME: home, REPO: repo, BUN: process.execPath, MACHINE: machine, CLICKHOUSE: binary }));
  run(['plutil', '-lint', target]);
  // An absent service is normal on first install; bootstrap/kickstart errors are fatal.
  if (spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status === 0) run(['launchctl', 'bootout', `${domain}/${label}`]);
  run(['launchctl', 'bootstrap', domain, target]);
  run(['launchctl', 'kickstart', '-k', `${domain}/${label}`]);
}
export function backfillArgs(days: number, rate: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || !Number.isFinite(rate) || rate <= 0 || rate > 5) throw Error('use --days positive integer and --rate-mb in (0,5]');
  return ['--backfill', '--since', new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10), '--rate-mb', String(rate)];
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
  mkdirSync(logs, { recursive: true });
  if (action === 'hub') {
    configureClient('m1', 'http://127.0.0.1:8123');
    for (const label of ['ship', 'drain']) if (spawnSync('launchctl', ['print', `${domain}/com.tokenlayer.${label}`], { stdio: 'ignore' }).status === 0) run(['launchctl', 'bootout', `${domain}/com.tokenlayer.${label}`]);
    mkdirSync(join(home, 'Library/Application Support/tokenlayer/clickhouse'), { recursive: true, mode: 0o700 });
    writeFileSync(join(config, 'clickhouse.xml'), render(readFileSync(join(repo, 'config/clickhouse.xml.template'), 'utf8'), { HOME: home }));
    install('com.tokenlayer.clickhouse', 'm1', args[0]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await fetch('http://127.0.0.1:8123/ping', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await Bun.sleep(500);
    }
    if (!ready) throw Error('ClickHouse /ping did not become ready');
    run([process.execPath, 'run', 'schema:apply'], { ...process.env, ...clientEnv() });
    run(['tailscale', 'serve', '--bg', '--https=8123', 'http://127.0.0.1:8123']);
  } else if (action === 'ship') {
    if (args[0] !== 'm1' && args[0] !== 'm4') throw Error('ship m1 | ship m4 https://hub.ts.net:8123');
    configureClient(args[0], args[0] === 'm1' ? 'http://127.0.0.1:8123' : args[1]);
    await ClickHouse.fromEnv(clientEnv()).exec('SELECT 1 FROM tokenlayer.v_sessions_daily LIMIT 0');
    if (args[0] === 'm1') {
      privateFile(join(config, 'hub.env'));
      if (!parseEnv(readFileSync(join(config, 'hub.env'), 'utf8')).CLIPROXY_MGMT_KEY) throw Error('hub.env missing management key');
      install('com.tokenlayer.drain', 'm1');
    }
    install('com.tokenlayer.ship', args[0]);
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
    const proc = Bun.spawn([process.execPath, 'src/ship/main.ts', ...flags], { cwd: repo, env: { ...process.env, TOKENLAYER_SHIP_STATE: state }, stdout: Bun.file(join(logs, 'backfill.log')), stderr: Bun.file(join(logs, 'backfill.err.log')) });
    process.exit(await proc.exited);
  } else throw Error('usage: setup.sh hub | ship m1 | ship m4 https://hub.ts.net:8123');
}
