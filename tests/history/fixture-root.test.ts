import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { historyFixtureDirectories } from '../fixtures/history-temp';

const fixture = historyFixtureDirectories('history-root-');
test('history state fixture stays outside repositories even with repo-local TMPDIR', () => {
  for (let path = fixture();; path = dirname(path)) {
    expect(existsSync(join(path, '.git')), `history state ancestor: ${path}`).toBe(false);
    if (dirname(path) === path) break;
  }
});
