/**
 * The one secret boundary for everything tokenlayer persists (ClickHouse rows, spool, rejects, logs):
 * API keys, bearer/OAuth tokens, JWTs, private keys, auth-file JSON and email addresses are replaced
 * with REDACTED. `redactDeep` recurses through objects, arrays and strings; `redactText` covers free text,
 * including JSON (or escaped JSON) embedded in a string.
 */
export const REDACTED = "[redacted]";

// Field names whose string/object value is always a secret. Compared lowercased with `-` folded to `_`.
const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "token",
  "bearer",
  "api_key",
  "apikey",
  "x_api_key",
  "authorization",
  "proxy_authorization",
  "cookie",
  "set_cookie",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "private_key",
]);
const KEY_ALT = "access_token|refresh_token|id_token|session_token|token|bearer|api[_-]?key|apikey|x-api-key|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|private_key";

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(bearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/\b(Basic\s+)[A-Za-z0-9+/]{16,}={0,2}/g, `$1${REDACTED}`],
  // "access_token": "…" in JSON, also when the JSON is itself escaped inside a string (\"access_token\":\"…\").
  [new RegExp(`(\\\\*"(?:${KEY_ALT})\\\\*"\\s*:\\s*\\\\*")[^"\\\\]*`, "gi"), `$1${REDACTED}`],
  // key=value / key: value in env files, headers and query strings.
  [new RegExp(`\\b((?:${KEY_ALT})\\s*[=:]\\s*)(?!["\\\\\\s])[^\\s"'&,;]+`, "gi"), `$1${REDACTED}`],
  [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{10,})/g,
    REDACTED,
  ],
  [/\b1\/\/0[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

const normalizeKey = (k: string) => k.toLowerCase().replace(/-/g, "_");

export function redactDeep(value: unknown, opts: { extraKeys?: readonly string[] } = {}): unknown {
  const extra = new Set((opts.extraKeys ?? []).map(normalizeKey));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      const key = normalizeKey(k);
      const secret = SENSITIVE_KEYS.has(key) || extra.has(key);
      out[redactText(k)] = secret && inner !== null && (typeof inner === "string" || typeof inner === "object") ? REDACTED : walk(inner);
    }
    return out;
  };
  return walk(value);
}
