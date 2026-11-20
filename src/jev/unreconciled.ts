/**
 * Jev reservations still unreconciled after the grace period: each is a failed or crashed call
 * (jev.py writes no reconciliation on a transport error, invalid response or crash). The window keeps
 * old research failures from holding the alert red forever. Grace covers the call timeout, the cost
 * lock wait and a 60 s drain tick.
 */
export const UNRECONCILED_GRACE_MINUTES = 15;
export const UNRECONCILED_WINDOW_HOURS = 24;

export function unreconciledSQL(graceMinutes = UNRECONCILED_GRACE_MINUTES, windowHours = UNRECONCILED_WINDOW_HOURS): string {
  return `SELECT count() FROM tokenlayer.systemone_calls FINAL
    WHERE isNotNull(reserved_at) AND isNull(reconciled_at)
      AND reserved_at < now64(3) - INTERVAL ${graceMinutes} MINUTE
      AND reserved_at >= now64(3) - INTERVAL ${windowHours} HOUR - INTERVAL ${graceMinutes} MINUTE`;
}
