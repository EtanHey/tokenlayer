// usage_json_age_s: the M4 writes ~/.config/tokenlayer/usage.json every 60 s for tools on the M4 (docs/usage-json.md),
// and the live rows run on the M1, so the probe reads the M4 copy over ssh.
// An M4 that is asleep or offline returns 'skip': nobody on the M4 reads a snapshot while it sleeps, so the row
// holds its state and posts nothing instead of FAIL at every lid close and cleared at every open.
// A reachable M4 with a stale or missing snapshot is a real failure (null = MISSING).

/** After a wake (or boot), the writer gets this long to replace the pre-sleep snapshot before it counts. */
export const USAGE_WAKE_GRACE_S = 180;
export const USAGE_HOST = 'macbook-pro';
// Remote stderr is discarded; only the wake/boot times, the M4 clock and the snapshot come back.
/** The M4's last wake, boot and clock: three lines that every M4 probe starts with (see awakeSeconds). */
export const WAKE_REMOTE = `printf 'wake %s\\nboot %s\\nnow %s\\n' "$(sysctl -n kern.waketime 2>/dev/null)" "$(sysctl -n kern.boottime 2>/dev/null)" "$(date +%s)"`;
const REMOTE = `${WAKE_REMOTE}; cat ~/.config/tokenlayer/usage.json 2>/dev/null`;
// ssh exits 255 for its own errors; these mean the Mac is not there. Anything else (a refused key) is a broken probe.
const UNREACHABLE = /Operation timed out|Connection timed out|No route to host|Host is down|Network is unreachable|Could not resolve hostname|Connection refused/;

export type Probe = { exitCode: number | null; stdout: string; stderr: string };

/** ssh's own error for a Mac that is not there (asleep, offline, off the tailnet): the row holds its state. */
export const unreachable = (probe: Probe) => probe.exitCode === 255 && UNREACHABLE.test(probe.stderr);

/** Seconds since the M4 last woke or booted, by the M4's own clock, from WAKE_REMOTE's three lines. */
export function awakeSeconds(stdout: string): number {
  const [wakeLine = '', bootLine = '', nowLine = ''] = stdout.split('\n');
  const seconds = (line: string) => Number(/sec = (\d+)/.exec(line)?.[1] ?? 0);
  return Number(nowLine.replace(/^now /, '')) - Math.max(seconds(wakeLine), seconds(bootLine));
}

/** Run `remote` on the M4 with short timeouts; stdin closed, so a stuck host never hangs the 15-minute job. */
export function sshM4(remote: string, host: string): Probe {
  const run = Bun.spawnSync(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', host, remote],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 20_000 });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

export function usageAge(probe: Probe, nowMs: number): number | null | 'skip' {
  if (unreachable(probe)) return 'skip';
  if (probe.exitCode !== 0) return null;
  const [, , nowLine = '', ...json] = probe.stdout.split('\n');
  const awakeFor = awakeSeconds(probe.stdout);
  const woke = Number(nowLine.replace(/^now /, '')) - awakeFor;
  let usage: { generated_at?: string | null; stale?: boolean };
  try { usage = JSON.parse(json.join('\n')); } catch { return null; }
  const generated = usage.generated_at ? Date.parse(usage.generated_at) : NaN;
  const fresh = usage.stale === false && Number.isFinite(generated);
  if (awakeFor < USAGE_WAKE_GRACE_S && !(fresh && generated >= woke * 1000)) return 'skip';
  return fresh ? (nowMs - generated) / 1000 : null;
}

export function readUsageAge(host = process.env.TOKENLAYER_USAGE_HOST || USAGE_HOST, now = Date.now): number | null | 'skip' {
  return usageAge(sshM4(REMOTE, host), now());
}
