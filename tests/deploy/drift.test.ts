import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { clickhouseBinary, diffPlist, drift, jobs, renderJob } from '../../scripts/deploy/jobs';

// Fixtures are the live plists of 19 Nov (M1 and M4) with the home folder as __HOME__, secrets and
// private paths replaced, and the two intentional changes applied: jobs run app/current (#196), and
// the M4 usage job runs Homebrew bun instead of the vite-plus shim (R9).
const home = '/Users/synthetic';
const site = { TOKENLAYER_DASHBOARD_LOGINS: 'synthetic@github', TOKENLAYER_DASHBOARD_ORIGIN: 'https://synthetic.invalid:8448', TOKENLAYER_RATCHET_OUTBOX: `${home}/outbox.md` };
const fixtures = 'tests/deploy/fixtures/plists';
mkdirSync('.local', { recursive: true });
const parse = (xml: string) => {
  const result = spawnSync('python3', ['-c', 'import json,plistlib,sys;json.dump(plistlib.loads(sys.stdin.buffer.read()),sys.stdout)'], { input: xml, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
};

for (const machine of ['m1', 'm4'] as const) {
  for (const file of readdirSync(`${fixtures}/${machine}`)) {
    const job = file.replace(/^com\.tokenlayer\.|\.plist$/g, '');
    test(`${machine} ${job}: the template renders the live plist`, () => {
      const rendered = renderJob(job, { home, machine, clickhouse: `${home}/.local/bin/clickhouse-pinned`, site: key => site[key as keyof typeof site] });
      expect(parse(rendered)).toEqual(parse(readFileSync(`${fixtures}/${machine}/${file}`, 'utf8').replaceAll('__HOME__', home)));
    });
  }
}

test('every job a Mac runs has a fixture, and every fixture a job', () => {
  for (const machine of ['m1', 'm4'] as const) {
    const expected = Object.entries(jobs).filter(([, j]) => j.machines.includes(machine) && !j.optional).map(([n]) => `com.tokenlayer.${n}.plist`).sort();
    expect(readdirSync(`${fixtures}/${machine}`).sort()).toEqual(expected);
  }
});

test('a site value missing from env and the installed plist is refused, never guessed', () => {
  expect(() => renderJob('dashboard', { home, machine: 'm1', site: () => undefined })).toThrow('TOKENLAYER_DASHBOARD_LOGINS');
});

test('diffPlist names each differing path and hides secret-shaped values', () => {
  const live = { Label: 'x', ProgramArguments: ['/a/bun', '/a/main.ts'], EnvironmentVariables: { PATH: '/bin', TOKENLAYER_DASHBOARD_LOGINS: 'me@github', CLICKHOUSE_PASSWORD: 'p1' } };
  const repo = { Label: 'x', ProgramArguments: ['/b/bun', '/a/main.ts'], EnvironmentVariables: { TOKENLAYER_DASHBOARD_LOGINS: 'you@github', CLICKHOUSE_PASSWORD: 'p2', NEW: '1' }, KeepAlive: true };
  const lines = diffPlist(live, repo);
  expect(lines).toEqual([
    'EnvironmentVariables.CLICKHOUSE_PASSWORD: values differ (hidden)',
    'EnvironmentVariables.NEW: live <absent>, repo "1"',
    'EnvironmentVariables.PATH: live "/bin", repo <absent>',
    'EnvironmentVariables.TOKENLAYER_DASHBOARD_LOGINS: values differ (hidden)',
    'KeepAlive: live <absent>, repo true',
    'ProgramArguments[0]: live "/a/bun", repo "/b/bun"',
  ]);
  expect(lines.join('\n')).not.toMatch(/p1|p2|me@|you@/);
  expect(diffPlist(repo, structuredClone(repo))).toEqual([]);
});

test('drift: clean jobs pass; changed, missing and unmanaged jobs fail; ignored labels are listed', () => {
  const root = mkdtempSync(`${process.cwd()}/.local/drift-`);
  mkdirSync(`${root}/Library/LaunchAgents`, { recursive: true });
  mkdirSync(`${root}/.config/tokenlayer`, { recursive: true });
  const options = { home: root, machine: 'm4' as const, parse, site: () => undefined };
  const agents = `${root}/Library/LaunchAgents`;
  for (const job of ['jev', 'ship', 'usage']) writeFileSync(`${agents}/com.tokenlayer.${job}.plist`, renderJob(job, { home: root, machine: 'm4' }));
  expect(drift(options)).toEqual({ drifted: false, lines: ['ok    jev', 'ok    ship', 'ok    usage'] });

  writeFileSync(`${agents}/com.tokenlayer.usage.plist`, renderJob('usage', { home: root, machine: 'm4' }).replace('/opt/homebrew/bin/bun', `${root}/.local/share/vite-plus/bin/bun`));
  writeFileSync(`${agents}/com.tokenlayer.spendtable.plist`, '<plist version="1.0"><dict><key>Label</key><string>com.tokenlayer.spendtable</string></dict></plist>');
  writeFileSync(`${agents}/com.tokenlayer.fable.plist`, renderJob('fable', { home: root, machine: 'm1' }));
  writeFileSync(`${agents}/com.example.other.plist`, '<plist version="1.0"><dict/></plist>');
  const result = drift(options);
  expect(result.drifted).toBe(true);
  expect(result.lines).toEqual([
    'DRIFT fable: installed, but the repo runs it on m1 only',
    'ok    jev',
    'ok    ship',
    'DRIFT spendtable: no template in this repo (add one, or list the label in ~/.config/tokenlayer/drift-ignore)',
    'DRIFT usage:',
    `        ProgramArguments[0]: live "${root}/.local/share/vite-plus/bin/bun", repo "/opt/homebrew/bin/bun"`,
  ]);

  writeFileSync(`${root}/.config/tokenlayer/drift-ignore`, '# outside this repo\ncom.tokenlayer.spendtable\ncom.tokenlayer.fable\n');
  rmSync(`${agents}/com.tokenlayer.ship.plist`);
  writeFileSync(`${agents}/com.tokenlayer.usage.plist`, renderJob('usage', { home: root, machine: 'm4' }));
  expect(drift(options)).toEqual({ drifted: true, lines: ['--    fable: ignored (drift-ignore)', 'ok    jev', 'DRIFT ship: not installed', '--    spendtable: ignored (drift-ignore)', 'ok    usage'] });
});

test('setup.sh <job> refuses before a pin, and hub/ship jobs point at their own action, without touching launchd', () => {
  const root = mkdtempSync(`${process.cwd()}/.local/job-`);
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/deploy/jobs.ts', 'install', ...args], { env: { ...process.env, HOME: root, PATH: '' }, encoding: 'utf8' });
  const fable = run('fable', 'm1');
  expect(fable.status).not.toBe(0);
  expect(fable.stderr).toContain('no pinned release');
  expect(run('ship', 'm4').stderr).toContain('installed by setup.sh ship');
  expect(run('usage', 'm1').stderr).toContain('usage runs on m4 only');
  for (const dir of ['Library/LaunchAgents', 'Library/Logs', '.config']) expect(existsSync(`${root}/${dir}`)).toBe(false); // bun's own cache aside, nothing written
});

test('the default ClickHouse binary is the one setup.sh hub downloads and verifies', () => {
  const ch = /CH="\$HOME\/([^"]+)"/.exec(readFileSync('scripts/deploy/setup.sh', 'utf8'))![1];
  expect(clickhouseBinary(home)).toBe(`${home}/${ch}`);
  expect(renderJob('clickhouse', { home, machine: 'm1' })).toContain(`<string>${home}/${ch}</string>`);
});
