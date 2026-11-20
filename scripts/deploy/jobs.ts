import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from '../../src/lib/env';
import { render } from './deploy';
import { replaceService } from './launchd';
import { appCurrent } from './pin';

// Every tokenlayer launchd job, the Macs it runs on, and the values its template needs, so that
// `setup.sh <job>` (or hub / ship) reproduces the live plist and `setup.sh drift` can prove it.
type Machine = 'm1' | 'm4';
type Job = {
  machines: Machine[];
  /** Installed by another setup.sh action (it also writes config and checks the store). */
  setup?: string;
  /** Not expected to be loaded; drift lists it only when it is. */
  optional?: true;
  /** REPO relative to home, when the job does not run the pinned app. */
  repo?: string;
  /** Placeholders whose values stay out of this public repo: taken from the environment, else from the installed plist. */
  site?: Record<string, string>;
};
export const jobs: Record<string, Job> = {
  clickhouse: { machines: ['m1'], setup: 'hub' },
  dashboard: { machines: ['m1'], site: { LOGINS: 'TOKENLAYER_DASHBOARD_LOGINS', ORIGIN: 'TOKENLAYER_DASHBOARD_ORIGIN' } },
  drain: { machines: ['m1'], setup: 'ship m1' },
  fable: { machines: ['m1'] },
  hubupdate: { machines: ['m1'] },
  jev: { machines: ['m1', 'm4'] },
  'ratchet-live': { machines: ['m1'], repo: '.config/tokenlayer/ratchet-live', site: { OUTBOX: 'TOKENLAYER_RATCHET_OUTBOX' } },
  ship: { machines: ['m1', 'm4'], setup: 'ship m1 | ship m4 <url>' },
  steer: { machines: ['m1'], optional: true },
  usage: { machines: ['m4'] },
};

const repo = resolve(import.meta.dir, '../..');
/** The ClickHouse binary `setup.sh hub` pins: its CH= line is the one place the version lives. */
export function clickhouseBinary(home = homedir()) {
  const pinned = /^\s*CH="\$HOME\/(\.local\/bin\/clickhouse-[^"/]+)"$/m.exec(readFileSync(join(repo, 'scripts/deploy/setup.sh'), 'utf8'));
  if (!pinned) throw Error('scripts/deploy/setup.sh has no CH= line');
  return join(home, pinned[1]);
}
const plistPath = (home: string, job: string) => join(home, 'Library/LaunchAgents', `com.tokenlayer.${job}.plist`);
function template(job: string) {
  const base = join(repo, 'launchd', `com.tokenlayer.${job}.plist`);
  return readFileSync(existsSync(`${base}.template`) ? `${base}.template` : base, 'utf8');
}

type Parse = (xml: string) => any;
/** Apple's own plist reader, from stdin: the parsed plist as JSON. */
const plutil: Parse = xml => {
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' });
  if (r.status !== 0) throw Error('plutil cannot parse the plist');
  return JSON.parse(r.stdout);
};

type RenderOptions = { home?: string; machine: Machine; clickhouse?: string; site?: (key: string) => string | undefined; parse?: Parse };
/** The plist the repo would install for job on machine. */
export function renderJob(job: string, o: RenderOptions) {
  const spec = jobs[job];
  if (!spec) throw Error(`unknown job ${job}`);
  const home = o.home ?? homedir();
  const values: Record<string, string> = { HOME: home, MACHINE: o.machine, REPO: spec.repo ? join(home, spec.repo) : appCurrent(home), CLICKHOUSE: o.clickhouse || clickhouseBinary(home) };
  for (const [name, key] of Object.entries(spec.site ?? {})) {
    const value = (o.site ?? siteValue(home, job, o.parse ?? plutil))(key);
    if (!value) throw Error(`${job}: set ${key} (it is kept out of this repo); the installed plist has none`);
    values[name] = value;
  }
  return render(template(job), values);
}
const siteValue = (home: string, job: string, parse: Parse) => (key: string) => {
  if (process.env[key]) return process.env[key];
  const path = plistPath(home, job);
  return existsSync(path) ? parse(readFileSync(path, 'utf8'))?.EnvironmentVariables?.[key] : undefined;
};

// drift output reaches logs (the after-merge installer keeps it), so it names paths and never prints a secret:
// - nothing under EnvironmentVariables is ever printed, only its key names;
// - elsewhere only numbers, booleans, paths and bare flags are printed; any other string (a --flag=value, a word in
//   ProgramArguments, a label) reads as "differs" with no value;
// - a dict or array is never printed whole: a block on one side only is listed key by key.
const PATH_OR_FLAG = /^(?:\/[\w.@+\/ -]*|--?[A-Za-z][\w-]*)$/;
const printable = (v: unknown) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && PATH_OR_FLAG.test(v));
const kind = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'object' ? 'dict' : typeof v);
const isBlock = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Each path where live and repo (the template) differ, with a value only where it is a path, flag, number or boolean. */
export function diffPlist(live: unknown, repo: unknown, path = '', env = false): string[] {
  if (isBlock(live) && isBlock(repo) && Array.isArray(live) === Array.isArray(repo)) {
    const array = Array.isArray(live);
    const keys = [...new Set([...Object.keys(live), ...Object.keys(repo)])].sort(array ? (a, b) => +a - +b : undefined);
    return keys.flatMap(k => diffPlist(live[k], repo[k], array ? `${path}[${k}]` : path ? `${path}.${k}` : k, env || k === 'EnvironmentVariables'));
  }
  if (isBlock(live) || isBlock(repo)) {
    // Missing on one side, or another kind there: name the kinds, then list each block against an empty one.
    const empty = (v: object) => (Array.isArray(v) ? [] : {});
    return [
      ...(live !== undefined && repo !== undefined ? [`${path}: differs (live <${kind(live)}>, template <${kind(repo)}>)`] : []),
      ...(isBlock(live) ? diffPlist(live, empty(live), path, env) : []),
      ...(isBlock(repo) ? diffPlist(empty(repo), repo, path, env) : []),
    ];
  }
  if (JSON.stringify(live) === JSON.stringify(repo)) return [];
  const show = (v: unknown) => (!env && printable(v) ? JSON.stringify(v) : undefined);
  if (repo === undefined) return [`${path}: only-live${show(live) ? ` (${show(live)})` : ''}`];
  if (live === undefined) return [`${path}: only-template${show(repo) ? ` (${show(repo)})` : ''}`];
  return [`${path}: differs${show(live) && show(repo) ? ` (live ${show(live)}, template ${show(repo)})` : ''}`];
}

type DriftOptions = { home?: string; machine: Machine; parse?: Parse; site?: (key: string) => string | undefined; clickhouse?: string };
/** Compare every installed com.tokenlayer.* plist with what the repo renders for this Mac. Read-only. */
export function drift(o: DriftOptions) {
  const home = o.home ?? homedir();
  const parse = o.parse ?? plutil;
  const agents = join(home, 'Library/LaunchAgents');
  const installed = new Set((existsSync(agents) ? readdirSync(agents) : []).map(f => /^com\.tokenlayer\.(.+)\.plist$/.exec(f)?.[1]).filter(Boolean) as string[]);
  const ignoreFile = join(home, '.config/tokenlayer/drift-ignore');
  const ignored = new Set(existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : []);
  const names = [...new Set([...installed, ...Object.keys(jobs).filter(j => jobs[j].machines.includes(o.machine) && !jobs[j].optional)])].sort();
  const lines: string[] = [];
  let drifted = false;
  const fail = (line: string, ...more: string[]) => { drifted = true; lines.push(line, ...more); };
  for (const job of names) {
    const spec = jobs[job];
    if (ignored.has(`com.tokenlayer.${job}`)) lines.push(`--    ${job}: ignored (drift-ignore)`);
    else if (!installed.has(job)) fail(`DRIFT ${job}: not installed`);
    else if (!spec) fail(`DRIFT ${job}: no template in this repo (add one, or list the label in ~/.config/tokenlayer/drift-ignore)`);
    else if (!spec.machines.includes(o.machine)) fail(`DRIFT ${job}: installed, but the repo runs it on ${spec.machines.join(' and ')} only`);
    else {
      let expected;
      try { expected = renderJob(job, { home, machine: o.machine, parse, site: o.site, clickhouse: o.clickhouse }); }
      catch (err) { fail(`DRIFT ${job}: cannot render (${(err as Error).message})`); continue; }
      const diff = diffPlist(parse(readFileSync(plistPath(home, job), 'utf8')), parse(expected));
      if (diff.length) fail(`DRIFT ${job}:`, ...diff.map(d => `        ${d}`));
      else lines.push(`ok    ${job}`);
    }
  }
  return { drifted, lines };
}
/** setup.sh <job>: render, lint and reload one job. Jobs that run the pinned app need a pin first. */
export async function installJob(job: string, machine: Machine, clickhouse = '', home = homedir()) {
  const xml = renderJob(job, { home, machine, clickhouse });
  if (xml.includes(appCurrent(home)) && !existsSync(join(appCurrent(home), '.tokenlayer-commit'))) throw Error('no pinned release; run scripts/deploy/setup.sh pin <sha> first');
  const agents = join(home, 'Library/LaunchAgents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(home, 'Library/Logs/tokenlayer'), { recursive: true });
  const target = plistPath(home, job);
  writeFileSync(target, xml);
  if (spawnSync('plutil', ['-lint', target], { stdio: 'inherit' }).status !== 0) throw Error(`plutil -lint ${target} failed`);
  await replaceService(`com.tokenlayer.${job}`, target);
}

export function thisMachine(home = homedir()): Machine {
  const env = join(home, '.config/tokenlayer/ship.env');
  const machine = existsSync(env) ? parseEnv(readFileSync(env, 'utf8')).TOKENLAYER_MACHINE : undefined;
  if (machine !== 'm1' && machine !== 'm4') throw Error('pass m1 or m4 (ship.env has no TOKENLAYER_MACHINE)');
  return machine;
}

if (import.meta.main) {
  const [action, ...args] = process.argv.slice(2);
  const machine = (args.find(a => a === 'm1' || a === 'm4') as Machine | undefined) ?? thisMachine();
  if (action === 'drift') {
    const result = drift({ machine });
    console.log(`launchd drift on ${machine}: live ~/Library/LaunchAgents vs this repo's templates`);
    for (const line of result.lines) console.log(line);
    process.exit(result.drifted ? 1 : 0);
  } else if (action === 'install' && jobs[args[0]] && !jobs[args[0]].setup) {
    if (!jobs[args[0]].machines.includes(machine)) throw Error(`${args[0]} runs on ${jobs[args[0]].machines.join(' and ')} only`);
    await installJob(args[0], machine);
  } else if (action === 'install' && jobs[args[0]]) {
    throw Error(`${args[0]} is installed by setup.sh ${jobs[args[0]].setup}`);
  } else throw Error(`usage: jobs.ts drift [m1|m4] | install <${Object.keys(jobs).filter(j => !jobs[j].setup).join('|')}> [m1|m4]`);
}
