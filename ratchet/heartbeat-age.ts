// ship_heartbeat_age_s_m1 / _m4: seconds since a Mac's ship daemon last wrote a heartbeat (schema/012, src/ship/heartbeat.ts).
// R2's shipper_live_lag_s measures recent events, so a shipper that stops and never restarts shows nothing there.
// The M4 sleeps for hours when it is carried, so a stale heartbeat alone can't page either: the M4 row first asks
// the M4 over ssh, as usage_json_age_s does. Asleep or off the tailnet → 'skip' (the row holds its state and posts
// nothing); awake with a stale heartbeat → the age (the row fails once, and clears when beats return).
// The M1 runs the rows itself, so its row has no probe.
import { awakeSeconds, sshM4, unreachable, USAGE_HOST, WAKE_REMOTE, type Probe } from './usage-age';
import type { Measured } from './live-schedule';

/** After a wake the daemon needs a pass and a working network before its first beat; inside this, an old beat is skipped. */
export const HEARTBEAT_WAKE_GRACE_S = 300;
export const HEARTBEAT_MACHINES = ['m1', 'm4'] as const;
export type HeartbeatMachine = (typeof HEARTBEAT_MACHINES)[number];

/** Age of the machine's newest heartbeat by the server's clock; no row at all reads n = 0. */
export const heartbeatAgeSQL = (machine: HeartbeatMachine) =>
  `SELECT count() AS n, dateDiff('millisecond', max(ingested_at), now64(3)) / 1000 AS age_s FROM tokenlayer.ship_heartbeat WHERE machine = '${machine}'`;

/** ageS: seconds since the newest beat, null = no beat. probe: the M4's ssh answer, or 'local' for the M1. */
export function heartbeatAge(probe: Probe | 'local', beat: { ageS: number | null }): number | null | 'skip' {
  if (probe === 'local') return beat.ageS;
  if (unreachable(probe)) return 'skip';
  // A refused key or a failed command is a broken probe, not a sleeping Mac.
  if (probe.exitCode !== 0) return null;
  const awakeFor = awakeSeconds(probe.stdout);
  if (!Number.isFinite(awakeFor)) return null;
  // Both ages are measured now, each by its own clock: a beat younger than the wake was written since it.
  const beatSinceWake = beat.ageS !== null && beat.ageS < awakeFor;
  if (awakeFor < HEARTBEAT_WAKE_GRACE_S && !beatSinceWake) return 'skip';
  return beat.ageS;
}

export async function readHeartbeatAge(machine: HeartbeatMachine, query: (sql: string) => Promise<{ n: number | string; age_s: number | string }[]>,
  host = process.env.TOKENLAYER_M4_HOST || USAGE_HOST): Promise<number | null | 'skip'> {
  // Probe first: an asleep M4 never needs the query.
  const probe = machine === 'm1' ? 'local' : sshM4(WAKE_REMOTE, host);
  if (probe !== 'local' && unreachable(probe)) return 'skip';
  const [row] = await query(heartbeatAgeSQL(machine));
  const ageS = row && Number(row.n) > 0 ? Number(row.age_s) : null;
  return heartbeatAge(probe, { ageS });
}

// ship_heartbeat_failing_m1 / _m4: the shipper is alive (it beats) but no pass in the window succeeded, so the age
// rows stay green while nothing ships. A healthy daemon passes every 10 s and writes an ok beat each minute, and a
// change from error to ok is written at once, so one good pass in the window shows. The window is the live job's
// own 15 minutes: each run judges the passes since the last run, and a single failed pass or a short outage
// (store_unreachable beats rarely land anyway: the beat goes to the same store) never pages.
export const FAILING_WINDOW_S = 900;

/** Beats, ok beats and the distinct error classes in the window, by the server's clock. */
export const heartbeatFailingSQL = (machine: HeartbeatMachine) =>
  `SELECT count() AS n, countIf(result = 'ok') AS ok, arraySort(groupUniqArrayIf(error_class, result != 'ok')) AS classes FROM tokenlayer.ship_heartbeat WHERE machine = '${machine}' AND ingested_at > now64(3) - INTERVAL ${FAILING_WINDOW_S} SECOND`;

export type FailingWindow = { n: number; ok: number; classes: string[] };

/**
 * Fails (value = the failing beats) when every beat in the window carries an error class. 'skip' holds the row's
 * state: no beat in the window (silence is the age row's job, and an asleep M4 must not clear a FAIL), the M4
 * unreachable, a broken probe (the age row reports it), or an M4 awake for less than the window, whose window
 * still holds passes from before the network came back.
 */
export function heartbeatFailing(probe: Probe | 'local', win: FailingWindow): Measured | 'skip' {
  if (probe !== 'local') {
    if (probe.exitCode !== 0) return 'skip';
    const awakeFor = awakeSeconds(probe.stdout);
    if (!Number.isFinite(awakeFor) || awakeFor < FAILING_WINDOW_S) return 'skip';
  }
  if (win.n === 0) return 'skip';
  const minutes = FAILING_WINDOW_S / 60;
  if (win.ok > 0) return { value: 0, threshold: 0, say: `${win.ok} of ${win.n} heartbeats in the last ${minutes} min ok` };
  return { value: win.n, threshold: 0, say: `all ${win.n} heartbeats in the last ${minutes} min failed (${win.classes.join(', ')}): the shipper runs, but no pass succeeds` };
}

export async function readHeartbeatFailing(machine: HeartbeatMachine, query: (sql: string) => Promise<{ n: number | string; ok: number | string; classes: string[] }[]>,
  host = process.env.TOKENLAYER_M4_HOST || USAGE_HOST): Promise<Measured | 'skip'> {
  const probe = machine === 'm1' ? 'local' : sshM4(WAKE_REMOTE, host);
  if (heartbeatFailing(probe, { n: 1, ok: 0, classes: [] }) === 'skip') return 'skip';
  const [row] = await query(heartbeatFailingSQL(machine));
  return heartbeatFailing(probe, { n: Number(row?.n ?? 0), ok: Number(row?.ok ?? 0), classes: row?.classes ?? [] });
}
