import { redactText } from './redact';

// Keep values private and append registrations so overridden startup-file values are safe too.
const secretForms = new Set<string>();
let exactPattern: RegExp | undefined;
export function registerSecrets(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    if (!/password|secret|token|key|auth/i.test(name) || !value) continue;
    const encoded = encodeURIComponent(value);
    for (const form of [value, encoded, encoded.replace(/%[0-9A-F]{2}/g, v => v.toLowerCase()),
      new URLSearchParams({ v: value }).toString().slice(2),
      Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) secretForms.add(form);
  }
  exactPattern = secretForms.size ? new RegExp([...secretForms].sort((a, b) => b.length - a.length)
    .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
}
registerSecrets(process.env);
export function sanitizeOutput(text: string): string {
  return redactText(exactPattern ? text.replace(exactPattern, '[redacted]') : text);
}

/** Sanitize output copies only. Never use these helpers on archive/ingest data. */
export function formatError(error: unknown): string {
  return sanitizeOutput(error instanceof Error ? error.stack ?? error.message : String(error));
}
export function writeOut(message: string): void {
  process.stdout.write(sanitizeOutput(message) + '\n');
}
export function writeErr(message: unknown): void {
  process.stderr.write(formatError(message) + '\n');
}
/** Install before initialization, including startup awaits. Fatal failures stay fatal. */
export function installErrorHandlers(): void {
  const fatal = (error: unknown) => { writeErr(error); process.exit(1); };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}
