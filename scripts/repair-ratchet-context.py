"""One closed repair of archived baseline setup; never execute a candidate judge.

The workflow pins this entire file before execution. Only the reviewed legacy
closure or its exact repaired form is accepted. All comparisons stay BASE_REF code.
Remove this bridge once every supported base contains the repaired setup.
"""
import hashlib
from pathlib import Path
import sys

LEGACY = {
    'ratchet/table.mjs': '6ec10a59d13a6732ad6657ebf71c2903aac21d3b56c96f13513e638b2e6ce8c9',
    'ratchet/run-rows.mjs': '5b6bec94ce6fb7fea0b6498b601d700ef3f967d5a000409dcd79fa8e8f40765e',
    'ratchet/measure.mjs': '3acbeb7734626deab667cc277b93f1f70ec2376008879e568800a2d95c9c7c29',
    'ratchet/guard.mjs': '100ea2a11ed14ad8669650345047cd18a44cb63eda8790239ae154a164ff235c',
    'ratchet/paired.mjs': '8b98a3728723a3e7877fdd6b7814a497c981bf5aab1850a8d6014e035f18fe3a',
    'ratchet/r1.ts': '66ec409a9e40c1e12975f8754aad9254a5c5f86e372ebe34795c6948da482f89',
    'scripts/bench-redact.ts': 'a0b09e3f6fe53a951c13fa8dfa62128cd72956a270e4ab4ad16d15427db52796',
    'src/lib/local-clickhouse.ts': '7c983fd67658ce5e24bc6ae904fa1dd96cc5b69b4b165cbfbeadcdc7afc16efa',
    'src/lib/clickhouse.ts': 'd0a557f72edc740000a1a9b4c57bb97529b86c89e2ab07b1cf25727ccce81f78',
    'src/lib/redact.ts': 'c39e9846f760859a2107321bd001d099a8a2895113ce5d3c394a82a55f356402',
}
REPAIRED_TABLE = 'dbe3f92a071d0d12bcf1e4ec02e1f0e12f6f63b25f2ba02db052f86e4c777319'
OLD_SETUP = """    const archive = git(['archive', measureRef]);
    if (spawnSync('tar', ['-x', '-C', scratch], { input: archive }).status !== 0) throw Error('extract base failed');
"""
NEW_SETUP = """    const measuredCommit = git(['rev-parse', '--verify', `${measureRef}^{commit}`], { encoding: 'utf8' }).trim();
    const sourceRepo = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const archive = git(['archive', measuredCommit]);
    if (spawnSync('tar', ['-x', '-C', scratch], { input: archive }).status !== 0) throw Error('extract base failed');
    // An archive under ignored .local must not discover the candidate's Git context.
    // Load the exact measured index without checkout, filters, or source-byte edits.
    git(['init', '--quiet', '--template=', scratch]);
    git(['-C', scratch, '-c', 'maintenance.auto=false', 'fetch', '--quiet', '--no-tags', '--depth=1', sourceRepo, measuredCommit]);
    git(['-C', scratch, 'read-tree', measuredCommit]);
    git(['-C', scratch, 'update-ref', 'HEAD', measuredCommit]);
"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repair(trusted, candidate=Path('.')):
    trusted, candidate = Path(trusted), Path(candidate)
    table = trusted / 'ratchet/table.mjs'
    legacy = digest(table) == LEGACY['ratchet/table.mjs']
    for path, old_hash in LEGACY.items():
        expected = REPAIRED_TABLE if path == 'ratchet/table.mjs' else old_hash
        base_expected = old_hash if legacy else expected
        if digest(trusted / path) != base_expected:
            raise ValueError('unreviewed base context-repair closure: ' + path)
        # Candidate production modules are the subject of measurement, not the judge.
        if not path.startswith('src/') and digest(candidate / path) != expected:
            raise ValueError('candidate context-repair closure out of sync: ' + path)
    if legacy:
        original = table.read_bytes()
        if original.count(OLD_SETUP.encode()) != 1:
            raise ValueError('legacy setup is not unique')
        repaired = original.replace(OLD_SETUP.encode(), NEW_SETUP.encode(), 1)
        if hashlib.sha256(repaired).hexdigest() != REPAIRED_TABLE:
            raise ValueError('unexpected repaired table bytes')
        table.write_bytes(repaired)
    print('baseline setup: exact reviewed closure; BASE_REF judge retained')


if __name__ == '__main__':
    try:
        repair(sys.argv[1])
    except (ValueError, OSError) as error:
        sys.exit(str(error))
