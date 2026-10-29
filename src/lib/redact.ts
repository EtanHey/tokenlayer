/**
 * Secret filtering for egress copies (logs, rejects and exported text); archive bytes stay exact.
 * API keys, bearer/OAuth tokens, JWTs, private keys, auth-file JSON and email addresses are replaced
 * with REDACTED. `redactDeep` recurses through objects, arrays and strings; `redactText` covers free text,
 * including JSON (or escaped JSON) embedded in a string.
 */
export const REDACTED = "[redacted]";

// Match key families regardless of case/separators. Usage counters are metadata, not credentials.
const KEY_NAME = "[a-z_][a-z0-9_.-]*";
const ASSIGNMENT = new RegExp(String.raw`(?:\\+[nr]|(?<![\w.-]))(?:--(${KEY_NAME})(?:[ \t]+|=[ \t]*)|(${KEY_NAME})(?:\\*["'])?[ \t]*[=:][ \t]*)`, "gi");
const SENSITIVE_NAME = /password|passwd|secret|token|key|auth|cookie|credential|session|bearer/i;
const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const sensitiveKey = (key: string) => SENSITIVE_NAME.test(normalizeKey(key).replace(/tokenlayer/g, '')) && !/^(?:(?:input|output|total|cached|cachereadinput|cachecreationinput)tokens(?:details)?|tokencount|totaltokenusage|lasttokenusage|sessionid|parentsessionid|clientkeyhash|authtype)$/.test(normalizeKey(key));

/** Shell arguments can join quoted/unquoted segments and escape otherwise separating bytes. */
function shellArgumentEnd(text: string, start: number): number {
  let quote = "";
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/[\s;&|<>()]/.test(ch)) break;
  }
  return Math.min(i, text.length);
}

/** Consume an entire quoted value, including escaped quotes at any JSON-string nesting depth. */
function valueEnd(text: string, start: number, wholeLine: boolean, wrapperAt: number, folded = false): { start: number; end: number } {
  let quoteAt = start;
  while (text[quoteAt] === "\\") quoteAt++;
  const quote = text[quoteAt];
  if (!wholeLine && (quote === '"' || quote === "'")) {
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
  if (!wholeLine && text.startsWith(REDACTED, start) && (start + REDACTED.length === text.length || stop.test(text[start + REDACTED.length]))) {
    return { start, end: start + REDACTED.length };
  }
  let wrapperStart = wrapperAt;
  while (text[wrapperStart - 1] === "\\") wrapperStart--;
  while (end < text.length) {
    if (!wholeLine && stop.test(text[end])) break;
    if (wholeLine && /[\r\n]/.test(text[end])) {
      const next = end + (text.startsWith("\r\n", end) ? 2 : 1);
      if (folded && /[ \t]/.test(text[next] ?? "")) { end = next; continue; }
      break;
    }
    if (wholeLine && /["']/.test(text[wrapperAt] ?? "") && text[end] === text[wrapperAt]) {
      let slashStart = end;
      while (text[slashStart - 1] === "\\") slashStart--;
      if (end - slashStart === wrapperAt - wrapperStart) { end = slashStart; break; }
    }
    end++;
  }
  return { start, end };
}

function redactAssignments(text: string, nesting = 0): string {
  const parts: string[] = [];
  let copied = 0;
  // Walk JSON string tokens once, in step with assignments. Decode only a token containing an
  // assignment, so real encoded newlines are boundaries while literal backslash+n/r stays secret.
  // A local matcher keeps recursive decoding from changing the outer scan's cursor.
  const assignment = new RegExp(ASSIGNMENT);
  const strings = /"(?:[^"\\\r\n]|\\.)*"/g;
  let string: RegExpExecArray | null | undefined;
  for (let match = assignment.exec(text); match; match = assignment.exec(text)) {
    const rawKey = match[1] ?? match[2];
    if (!sensitiveKey(rawKey)) continue;
    // Steer's credentials=<integer> is a counter; opaque, quoted and fractional values stay secret.
    if (/^credentials=$/i.test(match[0]) && /^\d+(?=\s|$)/.test(text.slice(assignment.lastIndex))) continue;
    while (string === undefined || (string && string.index + string[0].length <= match.index)) string = strings.exec(text);
    if (string && string.index < match.index && assignment.lastIndex < string.index + string[0].length) {
      try {
        const decoded = JSON.parse(string[0]) as string;
        const safe = nesting < 32 ? redactAssignments(decoded, nesting + 1) : REDACTED;
        parts.push(text.slice(copied, string.index), JSON.stringify(safe));
        copied = assignment.lastIndex = string.index + string[0].length;
        continue;
      } catch { /* A shell-quoted or malformed string is handled as raw text below. */ }
    }
    // Quoted object keys have JSON value boundaries; unquoted headers own folded lines.
    const header = match[0].includes(":") && !/["']/.test(match[0]);
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const env = !!match[2] && match[0].includes("=") && /^[ \t]*(?:export[ \t]+)?$/.test(text.slice(lineStart, match.index));
    const span = match[1] || (!env && match[0].includes("=") && !/[?&]/.test(text[match.index - 1] ?? ""))
      ? { start: assignment.lastIndex, end: shellArgumentEnd(text, assignment.lastIndex) }
      : valueEnd(text, assignment.lastIndex, header || env, match.index - 1, header);
    // A shell word may cross physical lines inside quotes or after a backslash.
    if (env) span.end = Math.max(span.end, shellArgumentEnd(text, assignment.lastIndex));
    if (span.end <= span.start) continue;
    parts.push(text.slice(copied, span.start), REDACTED);
    copied = span.end;
    assignment.lastIndex = span.end;
  }
  return copied ? parts.join("") + text.slice(copied) : text;
}

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/(\\+(?:[nrtbf]|u[0-9a-fA-F]{4})|\b)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${REDACTED}`],
  [/(\\+(?:[nrtbf]|u[0-9a-fA-F]{4})|\b)(Basic\s+)[A-Za-z0-9+/]{16,}={0,2}/g, `$1$2${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, `$1${REDACTED}@`],
  [
    /(\\+(?:[nrtbf]|u[0-9a-fA-F]{4})|\b)(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{10,})/g,
    `$1${REDACTED}`,
  ],
  [/(\\+(?:[nrtbf]|u[0-9a-fA-F]{4})|\b)1\/\/0[0-9A-Za-z_-]{20,}/g, `$1${REDACTED}`],
  [/(\\+(?:[nrtbf]|u[0-9a-fA-F]{4})|\b)eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, `$1${REDACTED}`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED],
];

/** Defense in depth for opaque tails near a sensitive name; never a global entropy scrub. */
function redactTails(text: string): string {
  return text.replace(/[A-Za-z0-9_+/-]{24,}={0,2}/g, (run, at: number) => {
    const before = text.slice(Math.max(0, at - 64), at);
    const after = text.slice(at + run.length, at + run.length + 64);
    const nearby = normalizeKey(`${before} ${after}`).replace(/tokenlayer/g, '');
    if (!SENSITIVE_NAME.test(nearby)) return run;
    // Keep identifiable paths, git hashes, UUIDs and numbers even near sensitive prose.
    if (/^[0-9]+$/.test(run) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run)
      || (/^[0-9a-f]{40,64}$/i.test(run) && /\b(?:git|sha|sha1|sha256|commit|hash)[\s:=_-]*$/i.test(before))
      || (/^\//.test(run) && /\b(?:path|file|cwd|docs)[\s:=]*$/i.test(before)) || /[\\/]/.test(text[at - 1] ?? "")) return run;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(run)).length;
    const counts = new Map<string, number>();
    for (const ch of run) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) { const p = count / run.length; entropy -= p * Math.log2(p); }
    return entropy >= (/^[0-9a-f]+$/i.test(run) ? 3 : classes < 2 ? 4.2 : 3.5) ? REDACTED : run;
  });
}

export function redactText(text: string): string {
  let out = redactAssignments(text);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return redactTails(out);
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
      const secret = sensitiveKey(k) || extra.has(key);
      out[redactText(k)] = secret && inner !== "" && inner !== null && (typeof inner === "string" || typeof inner === "object") ? REDACTED : walk(inner);
    }
    return out;
  };
  return walk(value);
}
