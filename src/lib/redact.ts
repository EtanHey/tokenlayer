/**
 * The one secret boundary for everything tokenlayer persists (ClickHouse rows, spool, rejects, logs):
 * API keys, bearer/OAuth tokens, JWTs, private keys, auth-file JSON and email addresses are replaced
 * with REDACTED. `redactDeep` recurses through objects, arrays and strings; `redactText` covers free text,
 * including JSON (or escaped JSON) embedded in a string.
 */
export const REDACTED = "[redacted]";

// Sensitive string/object fields; camelCase and hyphens normalize to snake_case.
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
  "key",
]);
const KEY_NAME = "[a-z_][a-z0-9_-]*";
const ASSIGNMENT = new RegExp(String.raw`(?<![\w-])(?:--(${KEY_NAME})(?:[ \t]+|=[ \t]*)|(${KEY_NAME})(?:\\*["'])?[ \t]*[=:][ \t]*)`, "gi");

const normalizeKey = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/-/g, "_");
const sensitiveKey = (key: string) => SENSITIVE_KEYS.has(key) || /_(?:password|passwd|key|token|secret)$/.test(key);

/** Consume an entire quoted value, including escaped quotes at any JSON-string nesting depth. */
function valueEnd(text: string, start: number, header: boolean, wrapperAt: number): { start: number; end: number } {
  let quoteAt = start;
  while (text[quoteAt] === "\\") quoteAt++;
  const quote = text[quoteAt];
  if (quote === '"' || quote === "'") {
    const depth = quoteAt - start;
    for (let i = quoteAt + 1; i < text.length; i++) {
      if (text[i] !== quote) continue;
      let slashStart = i;
      while (text[slashStart - 1] === "\\") slashStart--;
      // Quotes escaped inside the value have more slashes than its opening delimiter.
      if (i - slashStart === depth) return { start: quoteAt + 1, end: slashStart };
    }
    return { start: quoteAt + 1, end: text.length }; // Truncated secret: redact to end.
  }
  let end = start;
  const stop = /[\s"'&,;{}\]\\]/;
  if (!header && text.startsWith(REDACTED, start) && (start + REDACTED.length === text.length || stop.test(text[start + REDACTED.length]))) {
    return { start, end: start + REDACTED.length };
  }
  let wrapperStart = wrapperAt;
  while (text[wrapperStart - 1] === "\\") wrapperStart--;
  while (end < text.length) {
    if (!header && stop.test(text[end])) break;
    if (header && (/[\r\n]/.test(text[end]) || (text[end] === "\\" && /[nr]/.test(text[end + 1] ?? "")))) break;
    if (header && /["']/.test(text[wrapperAt] ?? "") && text[end] === text[wrapperAt]) {
      let slashStart = end;
      while (text[slashStart - 1] === "\\") slashStart--;
      if (end - slashStart === wrapperAt - wrapperStart) { end = slashStart; break; }
    }
    end++;
  }
  return { start, end };
}

function redactAssignments(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(text); match; match = ASSIGNMENT.exec(text)) {
    const key = normalizeKey(match[1] ?? match[2]);
    if (!sensitiveKey(key)) continue;
    const header = /^(?:(?:proxy_)?authorization|(?:set_)?cookie|x_.*_key)$/.test(key) && match[0].includes(":");
    const span = valueEnd(text, ASSIGNMENT.lastIndex, header, match.index - 1);
    if (span.end <= span.start) continue;
    parts.push(text.slice(copied, span.start), REDACTED);
    copied = span.end;
    ASSIGNMENT.lastIndex = span.end;
  }
  return copied ? parts.join("") + text.slice(copied) : text;
}

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/(\\[nr]|\b)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${REDACTED}`],
  [/\b(Basic\s+)[A-Za-z0-9+/]{16,}={0,2}/g, `$1${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, `$1${REDACTED}@`],
  [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{10,})/g,
    REDACTED,
  ],
  [/\b1\/\/0[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED],
];

export function redactText(text: string): string {
  let out = redactAssignments(text);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

export function redactDeep(value: unknown, opts: { extraKeys?: readonly string[] } = {}): unknown {
  const extra = new Set((opts.extraKeys ?? []).map(normalizeKey));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      const key = normalizeKey(k);
      const secret = sensitiveKey(key) || extra.has(key);
      out[redactText(k)] = secret && inner !== null && (typeof inner === "string" || typeof inner === "object") ? REDACTED : walk(inner);
    }
    return out;
  };
  return walk(value);
}
