import { expect, test } from 'bun:test';
import { projectFromCwd } from '../../src/ship/parse';
import { repoHint } from '../../src/archaeology/repo-evidence';
import { repoCwds } from '../fixtures/repo-cwds';

for (const [cwd, repo] of repoCwds) test(`shared cwd normalization: ${cwd}`, () => {
  expect(projectFromCwd(cwd)).toBe(repo);
  expect(repoHint(cwd)).toBe(repo === '(other)' ? '' : repo);
});
