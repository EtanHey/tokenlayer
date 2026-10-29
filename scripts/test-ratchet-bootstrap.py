"""Exercise bootstrap against real Git trees without changing branches or checkouts."""
import runpy
import subprocess

verify = runpy.run_path('scripts/check-ratchet-bootstrap.py')['verify']


def git(*args, data=None):
    return subprocess.check_output(['git', *args], input=data)


def replace(tree, name, sha):
    lines = git('ls-tree', tree).decode().splitlines()
    lines = [line.split()[0] + ' ' + line.split()[1] + ' ' + sha + '\t' + name
             if line.split('\t')[1] == name else line for line in lines]
    return git('mktree', data=('\n'.join(lines) + '\n').encode()).strip().decode()


verify('5271b827f652c1979eb4f17fb5708ba27155f899')
for path in ('ratchet/table.mjs', 'ratchet/run-rows.mjs', 'ratchet/measure.mjs'):
    blob = git('show', '5271b82:' + path) + b'\n'
    sha = git('hash-object', '-w', '--stdin', data=blob).strip().decode()
    tree = replace('5271b82:ratchet', path.split('/')[1], sha)
    root = replace('5271b82', 'ratchet', tree)
    try:
        verify(root)
    except ValueError as error:
        assert path in str(error), error
    else:
        raise AssertionError('accepted changed judge: ' + path)
print('bootstrap: current main accepted; one-byte mutations to all three judge files rejected')
