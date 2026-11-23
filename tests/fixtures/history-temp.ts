import { tmpdir } from 'node:os';
import { afterEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical scratch under the caller's TMPDIR. Test data only. */
export function historyFixtureDirectories(prefix: string) {
    const directories: string[] = [];
    afterEach(() => {
        for (const directory of directories) rmSync(directory, { recursive: true, force: true });
        directories.length = 0;
    });
    return () => {
        // mkdtemp creates an exclusive, mode-0700 directory; canonicalize the scratch root on macOS.
        const directory = mkdtempSync(join(realpathSync(tmpdir()), prefix));
        directories.push(directory);
        return directory;
    };
}
