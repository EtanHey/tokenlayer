import { redactText } from './redact';

/** Sanitize output copies only. Never use these helpers on archive/ingest data. */
export function formatError(error: unknown): string {
  return redactText(error instanceof Error ? error.stack ?? error.message : String(error));
}
export function writeOut(message: string): void {
  process.stdout.write(redactText(message) + '\n');
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
