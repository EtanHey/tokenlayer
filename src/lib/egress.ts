import { redactText, redactVerifiedFilePath } from './redact';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute } from 'node:path';

// Keep values private and append registrations so overridden startup-file values are safe too.
const secretForms = new Set<string>();
let exactPattern: RegExp | undefined;
export function registerSecrets(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    if (!/(^|_)(password|secret|token|key|auth)(_|$)/i.test(name) || !value) continue;
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

/** Only a hash-verified local restore bundle can use the structured path channel.
 * Remote diagnostics always use writeOut/writeErr and the unchanged opaque guard.
 * Shape/assignment and registered-secret stripping still apply to this path.
 */
export function writeVerifiedRestoreReceipt(receipt: {
  file: string; sha256: string; bytes: number; rows: number;
  scope: string; sourceComplete: string;
}): void {
  const { file, sha256, bytes, rows, scope, sourceComplete } = receipt;
  if (!isAbsolute(file) || /[\r\n\x00]/.test(file) || basename(file) !== 'session.jsonl'
    || !/^restore-[A-Za-z0-9]{6}$/.test(basename(dirname(file)))
    || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(rows) || rows < 1 || scope !== 'archived-contiguous-prefix' || sourceComplete !== 'unknown') {
    throw new Error('invalid structured restore receipt');
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== bytes || realpathSync(file) !== file) {
    throw new Error('invalid structured restore file');
  }
  const privateReceipt = JSON.parse(readFileSync(dirname(file) + '/receipt.json', 'utf8'));
  for (const key of ['file', 'sha256', 'bytes', 'rows', 'scope', 'sourceComplete'] as const) {
    if (privateReceipt[key] !== receipt[key]) throw new Error('restore receipt mismatch');
  }
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) throw new Error('restore file hash mismatch');
  const safePath = redactVerifiedFilePath(exactPattern ? file.replace(exactPattern, '[redacted]') : file);
  process.stdout.write(`file=${safePath}\n` + sanitizeOutput(`sha256=${sha256}\nbytes=${bytes}\nrows=${rows}\nscope=${scope}\nsourceComplete=${sourceComplete}`) + '\n');
}
