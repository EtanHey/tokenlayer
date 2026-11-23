import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One suite run, outside Bun's test runner: no nested full-suite load. */
export async function auditSuite(options: { command?: string[]; parent?: string; minimum?: number; quiet?: boolean } = {}) {
  const parent = options.parent ?? (process.env.CI && process.platform === 'linux' ? '/tmp' : resolve('docs.local/temp-cleanup'));
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, 'tl-'));
  try {
    const child = Bun.spawn(options.command ?? [process.execPath, 'test'], {
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdout: options.quiet ? 'ignore' : 'inherit', stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (!options.quiet) process.stderr.write(stderr);
    const entries = readdirSync(scratch);
    const passed = Number(/(?:^|\n)\s*(\d+) pass\b/.exec(stderr)?.[1] ?? 0);
    if (code !== 0 || passed < (options.minimum ?? 1000) || entries.length) {
      throw Error(`TMPDIR audit: exit=${code}, passed=${passed}, leftover=${JSON.stringify(entries)}\n${stderr}`);
    }
    return { passed };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { await auditSuite(); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
