import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const chrome = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  Bun.which('google-chrome'), Bun.which('google-chrome-stable'), Bun.which('chromium'), Bun.which('chromium-browser')]
  .find((path): path is string => !!path && existsSync(path));

test.skipIf(!chrome)('render harness owns Chrome scratch through process exit', () => {
  const parent = process.env.CI && process.platform === 'linux' ? '/tmp' : resolve('docs.local/temp-cleanup');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'rc-')), scratch = join(root, 't');
  mkdirSync(scratch);
  try {
    // Model the observed Linux Chrome leftover while still launching real Chrome and running every render.
    const wrapper = join(root, 'chrome');
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(wrapper, '#!/bin/sh\nmkdir "$TMPDIR/chrome-leftover"\nexec ' + quote(chrome!) + ' "$@"\n', { mode: 0o700 });
    const child = Bun.spawnSync([process.execPath, 'test', 'tests/dashboard/tools-render.test.ts'], {
      env: { ...process.env, CHROME_BIN: wrapper, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdout: 'pipe', stderr: 'pipe', timeout: 120000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stderr.toString()).toMatch(/6 pass\b/);
    expect(readdirSync(scratch)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 130000);
