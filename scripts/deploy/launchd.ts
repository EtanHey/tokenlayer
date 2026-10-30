import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Launchctl = (args: string[]) => { status: number | null; stderr: string };
const ctl: Launchctl = args => spawnSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
const domain = `gui/${process.getuid!()}`;
const pause = (ms: number) => Bun.sleep(ms);
async function stop(label: string, command: Launchctl, sleep: typeof pause) {
  if (command(['print', `${domain}/${label}`]).status !== 0) return false;
  if (command(['bootout', `${domain}/${label}`]).status !== 0) throw Error(`bootout ${label} failed`);
  for (let i = 0; i < 40; i++) {
    if (command(['print', `${domain}/${label}`]).status !== 0) return true;
    await sleep(250);
  }
  throw Error(`teardown ${label} timed out after 10 seconds`);
}
async function bootstrap(label: string, target: string, command: Launchctl, sleep: typeof pause) {
  for (let i = 0; i < 5; i++) {
    const result = command(['bootstrap', domain, target]);
    if (result.status === 0) return; // RunAtLoad starts it once; do not kill/restart it.
    if (!/Bootstrap failed: 5\b/.test(result.stderr)) throw Error(`bootstrap ${label} failed`);
    if (i < 4) await sleep(250 * (i + 1));
  }
  throw Error(`bootstrap ${label} failed after 5 attempts (launchd error 5)`);
}
export async function replaceService(label: string, target: string, command = ctl, sleep = pause) {
  await stop(label, command, sleep);
  await bootstrap(label, target, command, sleep);
}
export async function withPausedSidecars(work: () => Promise<void>, home = homedir(), command = ctl, sleep = pause) {
  const stopped: string[] = [];
  try {
    for (const label of ['com.tokenlayer.ship', 'com.tokenlayer.drain']) {
      if (await stop(label, command, sleep)) stopped.push(label);
    }
    await work();
  } finally {
    const failures: unknown[] = [];
    for (const label of stopped) {
      try { await bootstrap(label, join(home, 'Library/LaunchAgents', `${label}.plist`), command, sleep); }
      catch (err) { failures.push(err); }
    }
    if (failures.length) throw new AggregateError(failures, 'failed to restore stopped sidecars; rerun setup.sh ship m1');
  }
}
