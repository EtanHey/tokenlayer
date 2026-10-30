/** Slugs are lossy. Only these canonical names may be recovered without a recorded cwd. */
export const KNOWN_REPOS = [
  'golems', 'orchestrator', 'brainlayer', 'voicelayer', 'tokenlayer', 'skill-creator',
  'cmuxlayer', 'narrationlayer', 'etanheyman.com', 'jobRadarCoach', 't3code',
  'CLIProxyAPI', 'helium', 'golems-rig', 'golems-adash-tests', 'VoiceLayer-Lab',
];

// Extracted from archaeology's repoHint. Order preserves the enclosing Gits repo.
const cwdPatterns = [
  /^\/Users\/[^/]+\/(?:Desktop\/)?[Gg]its\/([^/]+)/,
  /^\/Users\/[^/]+\/\.t3\/worktrees\/([^/]+)/,
  /^\/Users\/[^/]+\/\.config\/superpowers\/worktrees\/([^/]+)/,
  /\/m1-lanes\/rigs\/([^/]+?)(?:-slot[12])?(?:\/|$)/,
];
const slugPattern = /(?:^|\/)(-Users-[^/]+)(?:\/|$)/;
function slugRepos() {
  const root = '^-Users-[^-]+-(?:(?:Desktop-)?Gits-|-(?:t3|config-superpowers)-worktrees-)';
  return [...KNOWN_REPOS].sort((a, b) => b.length - a.length).map(repo => ({
    repo, pattern: `${root}${repo.replace(/[^a-z0-9-]/gi, '-')}(-|$)`,
  }));
}

/** Pure lexical attribution, independent of the machine's filesystem. */
export function repoFromCwd(cwd: string): string {
  for (const regex of cwdPatterns) {
    const repo = regex.exec(cwd)?.[1];
    if (repo) return repo;
  }
  return '(other)';
}

/** Empty means absent evidence to archaeology. */
export function repoHint(cwd: string): string {
  const repo = repoFromCwd(cwd);
  return repo === '(other)' ? '' : repo;
}

// SQL is generated from the same patterns and canonical names, never hand-copied into a view.
const sqlString = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
export function repoFunctionsSQL(): string[] {
  const extracts = cwdPatterns.map(pattern => `nullIf(extract(cwd, ${sqlString(pattern.source)}), '')`);
  const matches = slugRepos().flatMap(({ repo, pattern }) => [`match(tokenlayer_project_slug(path), ${sqlString('(?i)' + pattern)})`, sqlString(repo)]);
  return [
    `CREATE OR REPLACE FUNCTION tokenlayer_project_slug AS path -> extract(path, ${sqlString(slugPattern.source)})`,
    `CREATE OR REPLACE FUNCTION tokenlayer_repo AS (cwd, path) -> if(cwd != '', coalesce(${extracts.join(', ')}, '(other)'), multiIf(${matches.join(', ')}, '(other)'))`,
  ];
}
