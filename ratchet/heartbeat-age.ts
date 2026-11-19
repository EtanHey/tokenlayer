// ship_heartbeat_age_s_m1 / _m4: seconds since a Mac's ship daemon last wrote a heartbeat (schema/012, src/ship/heartbeat.ts).
// R2's shipper_live_lag_s measures recent events, so a shipper that stops and never restarts shows nothing there.
// The M4 sleeps for hours when it is carried, so a stale heartbeat alone can't page either: the M4 row first asks
// the M4 over ssh, as usage_json_age_s does. Asleep or off the tailnet → 'skip' (the row holds its state and posts
// nothing); awake with a stale heartbeat → the age (the row fails once, and clears when beats return).
// The M1 runs the rows itself, so its row has no probe.
import { awakeSeconds, sshM4, unreachable, USAGE_HOST, WAKE_REMOTE, type Probe } from './usage-age';

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
