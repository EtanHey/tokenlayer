import { afterEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Importer state must stay outside repositories, even when CI puts TMPDIR in .local. Test data only. */
export function historyFixtureDirectories(prefix: string) {
    const directories: string[] = [];
    afterEach(() => {
        for (const directory of directories) rmSync(directory, { recursive: true, force: true });
        directories.length = 0;
    });
    return () => {
        // mkdtemp creates an exclusive, mode-0700 directory; canonicalize the scratch root on macOS.
        const directory = mkdtempSync(join(realpathSync('/tmp'), prefix));
        directories.push(directory);
        return directory;
    };
}
