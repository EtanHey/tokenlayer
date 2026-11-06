"""Self-contained process-crash checks; retained evidence, no downloads or live services."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
JAVA = Path('/opt/homebrew/opt/openjdk/bin/java').resolve()
JAR = Path.home() / '.cache/tla/tla2tools.jar'
BUN = (Path.home() / '.bun/bin/bun').resolve()
SOURCES = ['scripts/history/journal.ts', 'scripts/history/stream.ts', 'src/ship/state.ts',
           'tests/support/history-rotation-child.ts', 'tests/integration/history-revision.it.test.ts']
def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def valid(code, output, prop):
    errors = re.findall(r'^Error: (.*)$', output, re.M)
    if 'Warning:' in output or '*** Warnings:' in output:
        return False
    if prop is None:
        return code == 0 and not errors and 'Model checking completed. No error has been found.' in output
    return code == 12 and errors == [f'Invariant {prop} is violated.', 'The behavior up to this point is:']

def valid_source(code, output, marker):
    if re.search(r'\bwarnings?\b|^\s*(?:\*+\s*)?(?:(?:syntax|parse|semantic|tokenmgr)\s*error\b|fatal\s+error\b)\s*:?', output, re.I | re.M):
        return False
    diagnostics = [s.strip() for s in re.findall(r'^[ \t]*(?:\w+[ \t]+)*\w*(?:Error|Exception)[ \t]*:[^\n]*$', output, re.M | re.I)]
    if marker:
        return code == 1 and diagnostics == ['AssertionError: ' + marker]
    return code == 0 and not diagnostics and output.splitlines().count('SAMPLED_CONFORMANCE_PASS') == 1

def limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024**2, 4 * 1024**2))

def run(argv, cwd, log, seconds, env):
    with log.open('xb') as f:
        p = subprocess.Popen(argv, cwd=cwd, stdout=f, stderr=subprocess.STDOUT,
                             env=env, start_new_session=True, preexec_fn=limit)
        try:
            return p.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            raise TimeoutError(f'timed out: {argv[0]}; raw log retained')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='run-', dir=args.out)).resolve()
    deadline = time.monotonic() + 900
    env = {k:v for k,v in os.environ.items() if k not in {'JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'}}
    files = sorted(HERE.glob('*.*')) + [ROOT / s for s in SOURCES]
    pins = {str(p):sha(p) for p in files}
    receipt = {'pins':pins, 'results':[], 'complete':False, 'scope':'BOUNDED_PROCESS_CRASH + SAMPLED_SYNTHETIC_CODE; NOT_NATIVE; NOT_POWER_LOSS'}
    try:
        lock = json.loads((HERE / 'toolchain.json').read_text())
        v = subprocess.run([str(JAVA), '-version'], capture_output=True, timeout=5, env=env)
        version = (v.stdout + v.stderr).decode()
        receipt['tools'] = {'java':str(JAVA), 'java_sha256':sha(JAVA), 'version':version, 'jar':str(JAR), 'jar_sha256':sha(JAR)}
        bv = subprocess.run([str(BUN), '--version'], capture_output=True, timeout=5, env=env)
        assert bv.returncode == 0
        receipt['tools'].update({'bun':str(BUN), 'bun_sha256':sha(BUN), 'bun_version':bv.stdout.decode()})
        assert v.returncode == 0 and version == lock['java_version'] and sha(JAR) == lock['jar_sha256'], 'tool drift; no repair'
        m = json.loads((HERE / 'checks.json').read_text())
        mutants = m['mutants']
        fixture = 'Error: Invariant P is violated.\nError: The behavior up to this point is:\n'
        assert valid(12, fixture, 'P')
        assert all(not valid(c, t, 'P') for c,t in [(0,fixture),(12,fixture.replace('P','Q')),(12,'parse error'),(12,fixture+'Error: Deadlock reached.\n')])
        receipt['classifier_assertions'] = 5
        assert not valid(12, fixture.replace('P', 'AuditImmutable'), 'RetiringInodePublished')
        assert not valid_source(1, 'AssertionError: SHARED_APPEND_NOT_REFUSED', 'RETIRING_INODE_NOT_PUBLISHED')
        assert not valid_source(1, 'AssertionError: RETIRING_INODE_NOT_PUBLISHED', 'SHARED_APPEND_NOT_REFUSED')
        receipt['target_mismatch_controls'] = 3
        # Fail-first: each defect must violate its own named property before baseline success.
        cases = [(name, name, '', prop) for name,prop in mutants.items()]
        cases += [('safety','none','',None)]
        cases += [('reach-'+goal,'none',goal,'WitnessAbsent') for goal in m['reach']]
        receipt['expected_cases'] = [c[0] for c in cases]
        for name,mutation,goal,prop in cases:
            case = out / name
            case.mkdir()
            (case / 'Rotation.tla').write_bytes((HERE / 'Rotation.tla').read_bytes())
            cfg = 'SPECIFICATION Spec\nCONSTANTS\n Mutation = '+json.dumps(mutation)+'\n Goal = '+json.dumps(goal)+'\nCHECK_DEADLOCK FALSE\n'
            cfg += ''.join('INVARIANT '+p+'\n' for p in ([prop] if prop else dict.fromkeys(mutants.values())))
            (case / 'check.cfg').write_text(cfg)
            argv = [str(JAVA),'-Xmx512m','-XX:+UseParallelGC','-cp',str(JAR),'tlc2.TLC','-workers','1','-seed','1','-fp','0','-metadir',str(case/'states'),'-config','check.cfg','Rotation.tla']
            seconds = min(90, deadline-time.monotonic())
            assert seconds > 0, 'invocation deadline exhausted'
            code = run(argv, case, case/'raw.log', seconds, env)
            output = (case/'raw.log').read_text(errors='replace')
            states = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found',output)
            nonempty = bool(states) and int(states[-1][1].replace(',','')) > 0
            if name in {'missed-link-second', 'wrong-inode-second'}:
                nonempty = nonempty and 'active |-> 2' in output
            result = {'case':name, 'argv':argv, 'exit':code, 'expected_property':prop, 'valid':nonempty and valid(code,output,prop), 'cfg_sha256':sha(case/'check.cfg'), 'log_sha256':sha(case/'raw.log'), 'states':states}
            receipt['results'].append(result)
            print(json.dumps(result), flush=True)
            assert result['valid'], 'unexpected outcome; retained; remaining cases NOT_RUN'
        # Actual source mutant: bypass append's shared-inode guard, without changing product files.
        mutant = out/'journal-mutant.ts'
        original = (ROOT/'scripts/history/journal.ts').read_text()
        needle = 'if (this.shared() || this.size() + Buffer.byteLength(bytes) > this.cap)'
        assert original.count(needle) == 1
        mutant.write_text(original.replace(needle, 'if (this.size() + Buffer.byteLength(bytes) > this.cap)'))
        missed = out/'journal-missed-link.ts'
        link = "        linkSync(this.path, join(audit, `${basename(this.path, '.ndjson')}.${randomUUID()}.ndjson`));"
        assert original.count(link) == 1
        missed.write_text(original.replace(link, '        // REVIEW MUTANT: omitted old-inode archive hardlink effect.'))
        receipt['source_mutants'] = {p.name:sha(p) for p in [mutant, missed]}
        for name,source,marker in [('source-mutant',mutant,'SHARED_APPEND_NOT_REFUSED'),
                                   ('source-missed-link',missed,'RETIRING_INODE_NOT_PUBLISHED'),
                                   ('source-baseline',ROOT/'scripts/history/journal.ts',None)]:
            log = out/(name+'.log')
            argv = [str(BUN),'run',str(HERE/'conformance.ts'),str(source),str(out/name)]
            code = run(argv, ROOT, log, min(60,deadline-time.monotonic()),env)
            text = log.read_text()
            ok = valid_source(code, text, marker)
            receipt['results'].append({'case':name,'exit':code,'valid':ok,'expected_assertion':marker,'argv':argv,'log_sha256':sha(log)})
            assert ok, 'code binding failed; no conformance claim'
        assert all(sha(Path(p)) == h for p,h in pins.items()), 'source drift'
        assert sha(JAR) == receipt['tools']['jar_sha256'] and sha(JAVA) == receipt['tools']['java_sha256'], 'tool drift'
        assert sha(BUN) == receipt['tools']['bun_sha256'], 'Bun drift'
        receipt['complete'] = True
    except Exception as error:
        receipt['error'] = str(error)
    finally:
        receipt['not_run'] = [n for n in receipt.get('expected_cases', []) + ['source-mutant','source-missed-link','source-baseline'] if n not in {r['case'] for r in receipt['results']}]
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print('receipt='+str(out/'receipt.json'),flush=True)
    if not receipt['complete']:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
