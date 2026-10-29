"""Run TLC and prove the unknown-as-headroom mutant violates the raw-field oracle."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
out = root / 'docs.local' / 'admit-blind-mutation'
out.mkdir(parents=True, exist_ok=True)
source = (root / 'spec/Admit.tla').read_text()
mutant = source.replace('Usage(a) == CASE accounts[a] \\in {"zero", "rolled"}',
                        'Usage(a) == CASE accounts[a] \\in {"zero", "rolled", "unknown"}')
assert mutant != source
jar = os.environ.get('TLA_JAR', str(Path.home() / '.cache/tla/tla2tools.jar'))
for name, model, independent in [('baseline', source, True), ('old-oracle-mutant', mutant, False), ('raw-oracle-mutant', mutant, True)]:
    directory = out / name
    directory.mkdir(exist_ok=True)
    (directory / 'Admit.tla').write_text(model)
    config = (root / 'spec/Admit.cfg').read_text()
    if not independent:
        config = config.replace(' NoBlindAdmit', '')
    (directory / 'Admit.cfg').write_text(config)
    result = subprocess.run(['java', '-cp', jar, 'tlc2.TLC', '-workers', '1',
                             '-config', 'Admit.cfg', 'Admit.tla'], cwd=directory, capture_output=True, text=True)
    output = result.stdout + result.stderr
    (directory / 'tlc.log').write_text(output)
    print(name)
    print('\n'.join(line for line in output.splitlines() if 'states generated' in line or 'distinct states' in line or 'violated' in line or 'No error' in line))
    if name == 'raw-oracle-mutant':
        assert result.returncode != 0 and 'Invariant NoBlindAdmit is violated' in output, output
    else:
        assert result.returncode == 0 and 'No error' in output, output
