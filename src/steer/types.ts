/**
 * One entry of `GET /v8/management/credentials` (`files[]`), limited to the fields steer reads.
 * Source: CLIProxyAPI internal/api/handlers/management/auth_files.go buildAuthFileEntryLocked.
 */
export interface Credential {
  /** Credential ID; `PATCH /credentials/fields` accepts it as `name`. */
  id: string;
  auth_index?: string;
  name?: string;
  provider?: string;
  type?: string;
  /** `"oauth"` for subscription logins, `"api_key"` for API keys (Auth.AccountInfo). */
  account_type?: string;
  /** unknown | active | pending | refreshing | error | disabled */
  status?: string;
  disabled?: boolean;
  unavailable?: boolean;
  next_retry_after?: string | null;
  cooldowns?: Cooldown[] | null;
  /** Absent/null means 0 to the selector (selector.go authPriority). */
  priority?: number | null;
  /** Passive snapshot of the last upstream response's quota headers, e.g. `Anthropic-Ratelimit-Unified-7d-Reset`. */
  quota?: { observed_at?: string; signals?: Record<string, string> } | null;
}

export interface Cooldown {
  scope?: string;
  model_key?: string;
  reason?: string;
  retry_at?: string;
  remaining_seconds?: number;
}

/** A row of P4's `tokenlayer.credentials_snap` (schema/003_credentials_snap.sql), JSONEachRow-ready. */
export interface SnapshotRow {
  ts: string;
  hub: string;
  credential: string;
  provider: string;
  priority: number;
  status: string;
  disabled: boolean;
  unavailable: boolean;
  next_retry_after: string | null;
  reset_5h: string | null;
  reset_7d: string | null;
  utilization_5h: number | null;
  utilization_7d: number | null;
  signals: Record<string, string>;
  action: string;
}
