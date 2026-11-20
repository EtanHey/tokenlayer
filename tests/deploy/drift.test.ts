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

test('diffPlist names each differing path, never an env value, and prints only paths and flags elsewhere', () => {
  const live = { Label: 'x', ProgramArguments: ['/a/bun', '/a/main.ts'], EnvironmentVariables: { PATH: '/bin', TOKENLAYER_DASHBOARD_LOGINS: 'me@github', CLICKHOUSE_PASSWORD: 'p1' } };
  const repo = { Label: 'x', ProgramArguments: ['/b/bun', '/a/main.ts'], EnvironmentVariables: { TOKENLAYER_DASHBOARD_LOGINS: 'you@github', CLICKHOUSE_PASSWORD: 'p2', NEW: '1' }, KeepAlive: true };
  const lines = diffPlist(live, repo);
  expect(lines).toEqual([
    'EnvironmentVariables.CLICKHOUSE_PASSWORD: differs',
    'EnvironmentVariables.NEW: only-template',
    'EnvironmentVariables.PATH: only-live',
    'EnvironmentVariables.TOKENLAYER_DASHBOARD_LOGINS: differs',
    'KeepAlive: only-template (true)',
    'ProgramArguments[0]: differs (live "/a/bun", template "/b/bun")',
  ]);
  expect(lines.join('\n')).not.toMatch(/p1|p2|me@|you@/);
  expect(diffPlist(repo, structuredClone(repo))).toEqual([]);
});

// Security pre-review M2 (20 Nov): a block on one side only was printed whole, children and all. Values are synthetic.
const SECRET = /SYNTHETIC-SECRET/;
test('a block on one side only lists its key names, never its values, whatever the key is called', () => {
  const env = {
    CLIPROXY_MGMT_KEY: 'SYNTHETIC-SECRET-1', HUB_APIKEY: 'SYNTHETIC-SECRET-2', TOKENLAYER_AUTH: 'SYNTHETIC-SECRET-3', CLICKHOUSE_PASS: 'SYNTHETIC-SECRET-4',
    TOKENLAYER_MODE: 'SYNTHETIC-SECRET-5', NOTES: 'SYNTHETIC-SECRET-6', PATH: '/bin', TOKENLAYER_MACHINE: 'm1',
  };
  const names = Object.keys(env).sort();
  for (const [live, repo, side] of [[{ EnvironmentVariables: env }, {}, 'only-live'], [{}, { EnvironmentVariables: env }, 'only-template']] as const) {
    const lines = diffPlist(live, repo);
    expect(lines).toEqual(names.map(k => `EnvironmentVariables.${k}: ${side}`));
    expect(lines.join('\n')).not.toMatch(SECRET);
    expect(lines.join('\n')).not.toMatch(/\/bin|m1/); // innocent values are not printed either
  }
  const both = diffPlist({ EnvironmentVariables: env }, { EnvironmentVariables: Object.fromEntries(names.map(k => [k, 'other'])) });
  expect(both).toEqual(names.map(k => `EnvironmentVariables.${k}: differs`));
  expect(both.join('\n')).not.toMatch(SECRET);
  // A block that is a dict on one side and something else on the other names the shape, not the value.
  const shape = diffPlist({ EnvironmentVariables: { CLIPROXY_MGMT_KEY: 'SYNTHETIC-SECRET-1' } }, { EnvironmentVariables: 'SYNTHETIC-SECRET-7' });
  expect(shape).toEqual(['EnvironmentVariables: differs (live <dict>, template <string>)', 'EnvironmentVariables.CLIPROXY_MGMT_KEY: only-live']);
});

test('ProgramArguments prints paths and flags only; any other argument is redacted', () => {
  const live = { ProgramArguments: ['/opt/homebrew/bin/bun', '/app/current/src/ship/main.ts', '--password=SYNTHETIC-SECRET-8', 'SYNTHETIC-SECRET-9', '--machine', 'tail'] };
  const repo = { ProgramArguments: ['/opt/homebrew/bin/bun', '/app/current/src/ship/main.ts', '--password=SYNTHETIC-SECRET-10', 'SYNTHETIC-SECRET-11', '--verbose'] };
  const lines = diffPlist(live, repo);
  expect(lines).toEqual([
    'ProgramArguments[2]: differs',
    'ProgramArguments[3]: differs',
    'ProgramArguments[4]: differs (live "--machine", template "--verbose")',
    'ProgramArguments[5]: only-live',
  ]);
  expect(lines.join('\n')).not.toMatch(SECRET);
  const one = diffPlist(live, {});
  expect(one).toEqual([
    'ProgramArguments[0]: only-live ("/opt/homebrew/bin/bun")',
    'ProgramArguments[1]: only-live ("/app/current/src/ship/main.ts")',
    'ProgramArguments[2]: only-live',
    'ProgramArguments[3]: only-live',
    'ProgramArguments[4]: only-live ("--machine")',
    'ProgramArguments[5]: only-live',
  ]);
  expect(one.join('\n')).not.toMatch(SECRET);
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
    `        ProgramArguments[0]: differs (live "${root}/.local/share/vite-plus/bin/bun", template "/opt/homebrew/bin/bun")`,
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
