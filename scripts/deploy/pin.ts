import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Daemons run from ~/.config/tokenlayer/app/current, a symlink to app/<sha>: a copy of the tree at one commit.
// A checkout or pull in a git repo never changes a running job; installing and rolling back are a symlink flip.
const MARKER = '.tokenlayer-commit';
const FULL = /^[0-9a-f]{40}$/;
export const appRoot = (home = homedir()) => join(home, '.config/tokenlayer/app');
export const appCurrent = (home = homedir()) => join(appRoot(home), 'current');

type Deps = { install?: (dir: string) => void; kickstart?: (label: string) => void; labels?: string[] };
/** Only reviewed code gets the hub management key and the writer login: a release must be on this ref. */
export const MAIN = 'origin/main';
const bunInstall = (dir: string) => {
  const r = spawnSync(process.execPath, ['install', '--production', '--frozen-lockfile'], { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) throw Error('bun install --production failed');
};
const launchctlKickstart = (label: string) => {
  const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid!()}/${label}`], { stdio: 'inherit' });
  if (r.status !== 0) throw Error(`kickstart ${label} failed`);
};
const installed = (root: string, sha: string) => {
  const dir = join(root, sha);
  return FULL.test(sha) && existsSync(join(dir, MARKER)) && readFileSync(join(dir, MARKER), 'utf8') === `${sha}\n`;
};
function flip(root: string, sha: string) {
  const temp = join(root, `.current-${process.pid}`);
  rmSync(temp, { force: true });
  symlinkSync(sha, temp); // relative, so the app dir can move as a whole
  renameSync(temp, join(root, 'current')); // atomic: a job starting now sees the old or the new tree, never neither
}
function restart(labels: string[] = [], kickstart = launchctlKickstart) {
  for (const label of labels) kickstart(label);
}

/** Resolve rev in repo to a full commit SHA; anything else (options, tree paths, unknown names) is refused. */
function resolveCommit(repo: string, rev: string) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(rev)) throw Error(`not a commit: ${rev}`);
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { encoding: 'utf8' });
  const sha = r.stdout.trim();
  if (r.status !== 0 || !FULL.test(sha)) throw Error(`not a commit: ${rev}`);
  return sha;
}

/** sha is reachable from origin/main (fetch first). Exit 1 is "not an ancestor"; anything else is a git failure. */
export function onMain(repo: string, sha: string) {
  const r = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, MAIN], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw Error(`git merge-base ${sha} ${MAIN} failed: ${r.stderr.trim()}`);
  return r.status === 0;
}

/**
 * Copy the tree at rev into root/<sha> (git archive, then bun install --production), flip current, then kickstart labels.
 * A commit that is not on origin/main is refused before anything is written, unless allowUnmerged (rehearsals only).
 */
export async function installRelease(o: { repo: string; rev: string; root: string; allowUnmerged?: boolean; warn?: (line: string) => void } & Deps) {
  const sha = resolveCommit(o.repo, o.rev);
  if (!onMain(o.repo, sha)) {
    if (!o.allowUnmerged) throw Error(`${sha} is not on ${MAIN}: only merged code is pinned (fetch first; --allow-unmerged for a rehearsal)`);
    (o.warn ?? console.error)(`WARNING: ${sha} is not on ${MAIN}. Pinning unreviewed code: every repointed job runs it with the hub and writer credentials.`);
  }
  mkdirSync(o.root, { recursive: true, mode: 0o700 });
  if (!installed(o.root, sha)) {
    if (existsSync(join(o.root, sha))) throw Error(`${join(o.root, sha)} exists without a ${MARKER}; inspect and remove it`);
    const staging = join(o.root, `.staging-${sha}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    try {
      const archive = Bun.spawn(['git', '-C', o.repo, 'archive', '--format=tar', sha], { stdout: 'pipe', stderr: 'inherit' });
      const tar = Bun.spawn(['tar', '-x', '-f', '-', '-C', staging], { stdin: archive.stdout, stderr: 'inherit' });
      if ((await archive.exited) !== 0 || (await tar.exited) !== 0) throw Error(`git archive ${sha} failed`);
      (o.install ?? bunInstall)(staging);
      writeFileSync(join(staging, MARKER), `${sha}\n`); // last: only a complete copy carries it
      renameSync(staging, join(o.root, sha));
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }
  flip(o.root, sha);
  restart(o.labels, o.kickstart);
  return sha;
}

/** Rollback (or roll forward) to an already installed commit: flip current, then kickstart labels. */
export function useRelease(o: { root: string; sha: string } & Deps) {
  if (!installed(o.root, o.sha)) throw Error(`${o.sha} is not an installed release under ${o.root}`);
  flip(o.root, o.sha);
  restart(o.labels, o.kickstart);
}

/** Point every plist <string> that is the checkout, or a path inside it, at the pinned app. */
export function repoint(xml: string, checkout: string, app: string) {
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const from = escape(checkout);
  let hits = 0;
  const out = xml.replace(/<string>([^<]*)<\/string>/g, (whole, value: string) => {
    if (value !== from && !value.startsWith(`${from}/`)) return whole;
    hits++;
    return `<string>${escape(app)}${value.slice(from.length)}</string>`;
  });
  if (!hits) throw Error(`no checkout path ${checkout} in plist`);
  return out;
}

function status(root: string) {
  const link = join(root, 'current');
  if (!existsSync(root) || !lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return console.log('current: (none)');
  console.log(`current: ${readlinkSync(link)}`);
}

if (import.meta.main) {
  process.umask(0o077);
  const [action, target, ...rest] = process.argv.slice(2);
  const usage = 'usage: pin.ts install <rev> [--allow-unmerged] [--restart com.tokenlayer.<job>...] | use <sha> [--restart com.tokenlayer.<job>...] | repoint <plist> [checkout] | status';
  const allowUnmerged = action === 'install' && rest[0] === '--allow-unmerged';
  if (allowUnmerged) rest.shift();
  const labels = () => {
    if (rest.length && rest[0] !== '--restart') throw Error(usage);
    if (rest.slice(1).some(l => !/^com\.tokenlayer\.[a-z-]+$/.test(l))) throw Error('only com.tokenlayer.* labels can be restarted');
    return rest.slice(1);
  };
  const root = appRoot();
  if (action === 'install' && target) console.log(`installed ${await installRelease({ repo: resolve(import.meta.dir, '../..'), rev: target, root, labels: labels(), allowUnmerged })}`);
  else if (action === 'use' && target) useRelease({ root, sha: target, labels: labels() });
  else if (action === 'repoint' && target && rest.length <= 1) {
    // Rewrite one installed plist from the checkout to the pinned app; the caller lints and reloads it.
    writeFileSync(target, repoint(readFileSync(target, 'utf8'), rest[0] ?? join(homedir(), 'Gits/tokenlayer'), appCurrent()));
  } else if (action !== 'status') throw Error(usage);
  status(root);
}
