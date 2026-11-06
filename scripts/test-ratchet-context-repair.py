"""Real archived closure; all one-byte mutations fail before setup repair."""
from contextlib import redirect_stdout
import hashlib
import io
from pathlib import Path
import runpy
import subprocess
from tempfile import TemporaryDirectory

m = runpy.run_path('scripts/repair-ratchet-context.py')
repair, pins = m['repair'], m['LEGACY']
with TemporaryDirectory(prefix='context-repair-') as tmp:
    trusted, candidate = Path(tmp) / 'base', Path(tmp) / 'candidate'
    for path in pins:
        for root in (trusted, candidate):
            (root / path).parent.mkdir(parents=True, exist_ok=True)
        # The reviewed base table remains available even after the fix lands.
        original = subprocess.check_output(['git', 'show', '78eeb6579717222d7b6fe6ba26910adb6dc613db:' + path])
        assert hashlib.sha256(original).hexdigest() == pins[path]
        (trusted / path).write_bytes(original)
        (candidate / path).write_bytes(Path(path).read_bytes())
    with redirect_stdout(io.StringIO()):
        repair(trusted, candidate)
        assert (trusted / 'ratchet/table.mjs').read_bytes() == (candidate / 'ratchet/table.mjs').read_bytes()
        repair(trusted, candidate)  # already-repaired base (push / later PR)
        for root in (trusted, candidate):
            for path in pins:
                if root == candidate and path.startswith('src/'):
                    continue
                file = root / path
                before = file.read_bytes()
                file.write_bytes(before + b'\n')
                try:
                    repair(trusted, candidate)
                except ValueError as error:
                    assert path in str(error), error
                else:
                    raise AssertionError('accepted changed closure: ' + str(file))
                finally:
                    file.write_bytes(before)
        # Candidate production code is measured normally, never copied into judge.
        (candidate / 'src/lib/redact.ts').write_bytes(b'// measured candidate variation\n')
        repair(trusted, candidate)
        # Candidate exit(0) cannot replace the base judge.
        (candidate / 'ratchet/table.mjs').write_bytes(b'process.exit(0);\n')
        try:
            repair(trusted, candidate)
        except ValueError:
            pass
        else:
            raise AssertionError('accepted candidate judge substitution')
print('context repair: legacy + repaired base accepted; 17 closure mutations + judge substitution rejected; candidate source variation allowed')

# Exercise the exact workflow pin before any candidate repair code can execute.
workflow = Path('.github/workflows/ci.yml').read_text()
pin_step = workflow.split("            python3 -I - <<'PY_REPAIR'\n", 1)[1].split('          PY_REPAIR', 1)[0]
pin_step = '\n'.join(line[10:] for line in pin_step.splitlines())
with TemporaryDirectory(prefix='context-workflow-pin-') as tmp:
    p = Path(tmp) / 'scripts/repair-ratchet-context.py'
    p.parent.mkdir()
    p.write_bytes(Path('scripts/repair-ratchet-context.py').read_bytes())
    assert subprocess.run(['python3', '-I', '-c', pin_step], cwd=tmp).returncode == 0
    p.write_bytes(p.read_bytes() + b'\n')
    bad = subprocess.run(['python3', '-I', '-c', pin_step], cwd=tmp, capture_output=True)
    assert bad.returncode != 0 and b'unreviewed baseline context repair' in bad.stderr
print('workflow: exact repair bytes accepted; one-byte repair mutation rejected before execution')

# Neither the pin checker nor helper may import candidate Python modules.
with TemporaryDirectory(prefix='context-python-isolation-') as tmp:
    root = Path(tmp)
    (root / 'scripts').mkdir()
    helper = root / 'scripts/repair-ratchet-context.py'
    helper.write_bytes(Path('scripts/repair-ratchet-context.py').read_bytes())
    poison = "raise RuntimeError('CANDIDATE_HASHLIB_EXECUTED')\n"
    (root / 'hashlib.py').write_text(poison)
    (root / 'scripts/hashlib.py').write_text(poison)
    good = subprocess.run(['python3', '-I', '-c', pin_step], cwd=root, capture_output=True)
    assert good.returncode == 0, good.stderr
    helper.write_bytes(helper.read_bytes() + b'\n')
    bad = subprocess.run(['python3', '-I', '-c', pin_step], cwd=root, capture_output=True)
    assert bad.returncode != 0 and b'unreviewed baseline context repair' in bad.stderr
    helper.write_bytes(Path('scripts/repair-ratchet-context.py').read_bytes())
    closure = subprocess.run(['python3', '-I', str(helper), str(root / 'missing-base')], cwd=root, capture_output=True)
    assert closure.returncode != 0
    assert b'CANDIDATE_HASHLIB_EXECUTED' not in closure.stderr
assert 'python3 -I scripts/repair-ratchet-context.py "$trusted"' in workflow
print('Python isolation: root/script hashlib shadowing cannot run; altered helper still rejected')
