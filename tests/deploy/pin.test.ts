import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { appRoot, installRelease, repoint, useRelease } from '../../scripts/deploy/pin';

mkdirSync('.local', { recursive: true });
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
};
function fixture() {
  const base = mkdtempSync(join(process.cwd(), '.local/pin-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'bin'), { recursive: true });
  git(base, 'init', '-q', repo);
  writeFileSync(join(repo, 'version.txt'), 'one\n');
  writeFileSync(join(repo, 'bin/run'), '#!/bin/sh\necho one\n');
  chmodSync(join(repo, 'bin/run'), 0o755);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const one = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'version.txt'), 'two\n');
  git(repo, 'commit', '-qam', 'two');
  const two = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', two); // main is at two; anything else is unreviewed
  git(repo, 'checkout', '-qb', 'feat/unreviewed');
  writeFileSync(join(repo, 'version.txt'), 'unreviewed\n');
  git(repo, 'commit', '-qam', 'unreviewed');
  const unmerged = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'version.txt'), 'uncommitted\n'); // a dirty checkout must never leak into a release
  const calls: string[][] = [];
  const deps = { install: (dir: string) => { calls.push(['install', dir]); }, kickstart: (label: string) => { calls.push(['kickstart', label]); } };
  return { base, repo, root: join(base, 'app'), one, two, unmerged, calls, deps };
}
const current = (root: string) => readlinkSync(join(root, 'current'));

test('install copies the tree at the commit, not the checkout, then flips current', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  expect(current(f.root)).toBe(f.one); // relative link: the whole app dir can move
  expect(readFileSync(join(f.root, 'current/version.txt'), 'utf8')).toBe('one\n');
  expect(readFileSync(join(f.root, f.one, '.tokenlayer-commit'), 'utf8')).toBe(`${f.one}\n`);
  expect(statSync(join(f.root, 'current/bin/run')).mode & 0o111).toBe(0o111);
  expect(f.calls).toEqual([['install', expect.stringContaining('.staging-')]]);
  await installRelease({ repo: f.repo, rev: f.two.slice(0, 9), root: f.root, ...f.deps });
  expect(current(f.root)).toBe(f.two);
  expect(readFileSync(join(f.root, 'current/version.txt'), 'utf8')).toBe('two\n');
  expect(existsSync(join(f.root, f.one, 'version.txt'))).toBe(true); // kept for rollback
});

test('a failed dependency install leaves current and the release dir untouched', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  await expect(installRelease({ repo: f.repo, rev: f.two, root: f.root, ...f.deps, install: () => { throw Error('bun install failed'); } })).rejects.toThrow('bun install failed');
  expect(current(f.root)).toBe(f.one);
  expect(existsSync(join(f.root, f.two))).toBe(false);
  expect(require('node:fs').readdirSync(f.root).filter((n: string) => n.startsWith('.staging-'))).toEqual([]);
});

test('install refuses a revision that is not a commit and changes nothing', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  for (const rev of ['nope', '--output=/etc/x', 'HEAD:version.txt']) {
    await expect(installRelease({ repo: f.repo, rev, root: f.root, ...f.deps })).rejects.toThrow();
  }
  expect(current(f.root)).toBe(f.one);
});

test('install refuses a commit that is not on origin/main, unless the caller allows unmerged code', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  for (const rev of [f.unmerged, 'feat/unreviewed', f.unmerged.slice(0, 9)])
    await expect(installRelease({ repo: f.repo, rev, root: f.root, ...f.deps })).rejects.toThrow('not on origin/main');
  expect(current(f.root)).toBe(f.one);
  expect(existsSync(join(f.root, f.unmerged))).toBe(false);
  expect(f.calls).toEqual([['install', expect.any(String)]]);
  await installRelease({ repo: f.repo, rev: f.unmerged, root: f.root, ...f.deps, allowUnmerged: true });
  expect(current(f.root)).toBe(f.unmerged);
});

test('pin.ts install refuses an unmerged commit before it writes anything, and --allow-unmerged warns', () => {
  const f = fixture();
  const home = join(f.base, 'home');
  mkdirSync(home);
  mkdirSync(join(f.repo, 'scripts/deploy'), { recursive: true }); // the CLI archives the repo it sits in
  writeFileSync(join(f.repo, 'scripts/deploy/pin.ts'), readFileSync('scripts/deploy/pin.ts'));
  const pin = (...args: string[]) => spawnSync(process.execPath, [join(f.repo, 'scripts/deploy/pin.ts'), 'install', ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const refused = pin(f.unmerged);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('not on origin/main');
  expect(existsSync(join(home, '.config'))).toBe(false);
  const allowed = pin(f.unmerged, '--allow-unmerged');
  expect(allowed.stderr).toContain(`WARNING: ${f.unmerged} is not on origin/main`);
  expect(allowed.stdout).toContain(`current: ${f.unmerged}`);
});

test('reinstalling an installed commit reuses it and only flips', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  await installRelease({ repo: f.repo, rev: f.two, root: f.root, ...f.deps });
  f.calls.length = 0;
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  expect(current(f.root)).toBe(f.one);
  expect(f.calls).toEqual([]);
});

test('rollback flips back to an installed commit and kickstarts only after the flip', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  await installRelease({ repo: f.repo, rev: f.two, root: f.root, ...f.deps, labels: ['com.tokenlayer.ship'] });
  expect(f.calls.at(-1)).toEqual(['kickstart', 'com.tokenlayer.ship']);
  f.calls.length = 0;
  const seen: string[] = [];
  useRelease({ root: f.root, sha: f.one, labels: ['com.tokenlayer.ship', 'com.tokenlayer.drain'], kickstart: label => { seen.push(`${label}@${current(f.root)}`); } });
  expect(seen).toEqual([`com.tokenlayer.ship@${f.one}`, `com.tokenlayer.drain@${f.one}`]);
});

test('rollback refuses a commit that is not fully installed', async () => {
  const f = fixture();
  await installRelease({ repo: f.repo, rev: f.one, root: f.root, ...f.deps });
  mkdirSync(join(f.root, f.two)); // no marker: a half-copied tree
  for (const sha of [f.two, 'a'.repeat(40), '../x', f.one.slice(0, 9)]) expect(() => useRelease({ root: f.root, sha, ...f.deps })).toThrow();
  expect(current(f.root)).toBe(f.one);
  expect(f.calls).toEqual([['install', expect.any(String)]]);
});

const home = '/Users/synthetic';
test('repoint moves checkout paths to the pinned app and leaves everything else alone', () => {
  const plist = [
    '<plist><dict>',
    `<key>ProgramArguments</key><array><string>/opt/homebrew/bin/bun</string><string>${home}/Gits/tokenlayer/src/ship/main.ts</string></array>`,
    `<key>WorkingDirectory</key><string>${home}/Gits/tokenlayer</string>`,
    `<key>Other</key><string>${home}/Gits/tokenlayer-d1/x</string><string>${home}/Gits/tokenlayer2</string>`,
    `<key>Log</key><string>${home}/Library/Logs/tokenlayer/ship.log</string>`,
    '</dict></plist>',
  ].join('\n');
  const out = repoint(plist, `${home}/Gits/tokenlayer`, `${home}/.config/tokenlayer/app/current`);
  expect(out).toContain(`<string>${home}/.config/tokenlayer/app/current/src/ship/main.ts</string>`);
  expect(out).toContain(`<key>WorkingDirectory</key><string>${home}/.config/tokenlayer/app/current</string>`);
  expect(out).toContain(`<string>${home}/Gits/tokenlayer-d1/x</string><string>${home}/Gits/tokenlayer2</string>`);
  expect(out).toContain('<string>/opt/homebrew/bin/bun</string>');
  expect(() => repoint(out, `${home}/Gits/tokenlayer`, `${home}/.config/tokenlayer/app/current`)).toThrow('no checkout path');
});

test('app root lives under the private tokenlayer config dir', () => {
  expect(appRoot(home)).toBe(`${home}/.config/tokenlayer/app`);
});
