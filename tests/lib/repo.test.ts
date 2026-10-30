import { expect, test } from 'bun:test';
import { projectFromCwd } from '../../src/ship/parse';
import { repoHint } from '../../src/archaeology/repo-evidence';
import { repoCwds } from '../fixtures/repo-cwds';
import { repoFromCwd } from '../../src/lib/repo';

test('repoFromCwd drops the filesystem-only .noindex suffix', () => {
  expect(repoFromCwd('/Users/etanheyman/Gits/VoiceLayer-Lab.noindex/2026-10-30/exploration/code')).toBe('VoiceLayer-Lab');
});

for (const [cwd, repo] of repoCwds) test(`shared cwd normalization: ${cwd}`, () => {
  expect(projectFromCwd(cwd)).toBe(repo);
  expect(repoHint(cwd)).toBe(repo === '(other)' ? '' : repo);
});
