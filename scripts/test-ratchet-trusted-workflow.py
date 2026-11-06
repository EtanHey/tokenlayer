"""Execute the workflow shell: repaired bases run only their archived judge."""
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import textwrap

workflow = Path('.github/workflows/ci.yml').read_text()
step = textwrap.dedent(workflow.split('      - name: Ratchet (trusted base versus this PR)\n', 1)[1]
                       .split('        run: |\n', 1)[1].split('  raise-floor:', 1)[0])

with TemporaryDirectory(prefix='trusted-workflow-') as tmp:
    root = Path(tmp)

    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

    git('init', '-q', '--template=')
    judge = """import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
assert.match(fileURLToPath(import.meta.url), /\\/.local\\/trusted-[^/]+\\/ratchet\\/table.mjs$/);
assert.equal(readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  execFileSync('git', ['show', `${process.env.RATCHET_BASE_REF}:ratchet/table.mjs`], { encoding: 'utf8' }));
assert.equal(process.argv[2], 'ratchet/rows.json');
console.log('ARCHIVED_BASE_REF_JUDGE');
process.exit(23);
"""
    files = {
        'ratchet/table.mjs': judge,
        'ratchet/guard.mjs': '// repaired supported base\n',
        'ratchet/rows.json': '{}\n',
        'scripts/bench-redact.ts': '// archive closure fixture\n',
        'src/lib/local-clickhouse.ts': '// archive closure fixture\n',
        'src/lib/clickhouse.ts': '// archive closure fixture\n',
        'src/lib/redact.ts': '// archive closure fixture\n',
        'tests/fixtures/control': 'archive fixture\n',
    }
    for path, value in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
    git('add', '.')
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
        'commit', '-qm', 'trusted workflow fixture')
    base = git('rev-parse', 'HEAD')
    (root / 'ratchet/table.mjs').write_text("throw Error('CANDIDATE_JUDGE_EXECUTED');\n")
    (root / 'scripts/repair-ratchet-context.py').write_text("raise RuntimeError('CANDIDATE_BRIDGE_EXECUTED')\n")
    (root / 'hashlib.py').write_text("raise RuntimeError('CANDIDATE_HASHLIB_EXECUTED')\n")
    result = subprocess.run(['bash', '-c', step], cwd=root, capture_output=True, text=True,
                            env={**os.environ, 'RATCHET_BASE_REF': base})
    assert result.returncode == 23, (result.returncode, result.stdout, result.stderr)
    assert result.stdout.strip() == 'ARCHIVED_BASE_REF_JUDGE', result.stdout
    assert 'CANDIDATE_' not in result.stderr, result.stderr

print('trusted workflow: BASE_REF archived judge executed; candidate judge/bridge/modules ignored; judge exit propagated')
