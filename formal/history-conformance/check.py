"""Portable sampled code bindings; retained real integration gates remain separate."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
CORPUS_SHA256 = 'fdd6498712be13abf50dc5a53fc54ab48ef98503fc9c58639cca45e876802800'
VARIANTS = ['checkpoint-first', 'ack-missing', 'acceptance-bypass', 'stop-recheck-removed', 'current']
# Removing PR133's post-reconcile recheck restores the historical (d737a6e) stop region.
RECHECK = """            // Reconciliation can yield after the earlier stop check.
            if (this.options.shouldStop?.())
                throw Error('history stopped before dispatch');
            this.record(intent, 'intent');"""


def strict_json(output):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON result member')
            result[key] = value
        return result
    return json.loads(output, object_pairs_hook=unique)


def valid_result(code, output, expected):
    try: observed = strict_json(output)
    except ValueError: return False
    target = {'outcome': 'OBLIGATION_FAILED', 'obligation': expected, 'error': 'Error: ' + expected} if expected else {'outcome': 'PASS_SAMPLED_BINDING', 'mode': 'all'}
    return code == (2 if expected else 0) and observed == target


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--corpus', type=Path, default=HERE / 'corpus.json')
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
run = Path(tempfile.mkdtemp(prefix='run-', dir=args.out.resolve()))
receipt = {'scope': 'SAMPLED_ACTUAL_CODE; current RecheckStop=TRUE stop refusal; historical stop violation only as source mutant; retained real integration gates separate', 'results': [], 'complete': False}
try:
    assert sha(args.corpus) == CORPUS_SHA256, 'missing/corrupt/unapproved corpus'
    corpus = json.loads(args.corpus.read_text())
    assert corpus['schema'] == 'tokenlayer.history-conformance.corpus.v2'
    assert sha(SOURCE / corpus['model']['path']) == corpus['model']['sha256'], 'model/corpus drift'
    assert len(corpus['obligations']) == 8 and corpus['obligations']['current-safety']['outcome'] == 'PASS'
    for item in corpus['obligations'].values():
        assert hashlib.sha256(item['configuration']['text'].encode()).hexdigest() == item['configuration']['sha256']
    (run / 'obligations.json').write_bytes(args.corpus.read_bytes())
    paths = {SOURCE / p for p in ['scripts/history/run.ts', 'scripts/history/stream.ts', 'src/ship/ship.ts']}
    scanned = set()
    while paths - scanned:
        path = next(iter(paths - scanned)); scanned.add(path)
        for rel in re.findall(r'\bfrom\s*[\'"](\.[^\'"]+)[\'"]', path.read_text()):
            dependency = (path.parent / (rel + '.ts')).resolve()
            assert dependency.is_relative_to(SOURCE)
            paths.add(dependency)
    paths.add(SOURCE / 'schema/004_session_events.sql')
    sourcepins = {str(p.relative_to(SOURCE)): sha(p) for p in sorted(paths)}
    executable = shutil.which('bun')
    if not executable: raise RuntimeError('required Bun executable missing')
    bun = Path(executable).resolve()
    receipt.update(source_pins=sourcepins, corpus_sha256=CORPUS_SHA256, model=corpus['model'], tool={'bun': str(bun), 'sha256': sha(bun),
        'version': subprocess.check_output([str(bun), '--version'], text=True).strip()},
        adapter_sha256=sha(HERE / 'bind.ts'), runner_sha256=sha(Path(__file__)))
    mutations = {
        'checkpoint-first': ('src/ship/ship.ts', 'await opts.clickhouse.insert("session_events", rows, token);', 'cp.offset = nextOffset; save(); await opts.clickhouse.insert("session_events", rows, token);', 'ordering', 'ACK_BEFORE_CHECKPOINT'),
        'ack-missing': ('scripts/history/stream.ts', "this.record(intent, 'acked');", "/* source sensitivity: omit durable ACK */", 'ordering', 'ACK_BEFORE_CHECKPOINT'),
        'acceptance-bypass': ('scripts/history/run.ts', 'if (Number(count?.n) !== (pilot ? 32 : check.nonemptyLines))', 'if (false && Number(count?.n) !== (pilot ? 32 : check.nonemptyLines))', 'acceptance', 'FINAL_ACCEPTANCE_GUARD'),
        'stop-recheck-removed': ('scripts/history/stream.ts', RECHECK, "            this.record(intent, 'intent');", 'stop', 'STOP_BEFORE_DISPATCH')}
    for name in VARIANTS:
        snapshot = run / name; snapshot.mkdir()
        for rel in sourcepins:
            target = snapshot / rel; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes((SOURCE / rel).read_bytes())
        mode, expected = 'all', None
        if name in mutations:
            rel, old, new, mode, expected = mutations[name]; target = snapshot / rel
            before = target.read_text(); assert before.count(old) == 1
            target.write_text(before.replace(old, new))
            (run / (name + '.patch')).write_text(''.join(difflib.unified_diff(before.splitlines(True), target.read_text().splitlines(True), fromfile='a/' + rel, tofile='b/' + rel)))
        scratch = Path(tempfile.mkdtemp(prefix='tokenlayer-conformance-')).resolve()
        argv = [str(bun), str(HERE / 'bind.ts'), str(snapshot), str(scratch), str(run / 'obligations.json'), mode]
        log = run / (name + '.log')
        def limit(): resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024 ** 2, 4 * 1024 ** 2))
        with log.open('xb') as stream:
            child = subprocess.Popen(argv, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limit, env={'PATH': '/usr/bin:/bin', 'TZ': 'UTC'})
            try: code = child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(); raise RuntimeError('timeout; not an intended failure')
        observed = strict_json(log.read_text())
        valid = valid_result(code, log.read_text(), expected)
        result = {'name': name, 'argv': argv, 'scratch': str(scratch), 'exit': code, 'expected_obligation': expected, 'observed': observed, 'valid': valid, 'log_sha256': sha(log)}
        receipt['results'].append(result)
        (run / (name + '-observations.json')).write_bytes((scratch / 'observations.json').read_bytes())
        if not valid: raise RuntimeError('unexpected result; preserve remaining cases NOT_RUN')
        observations = strict_json((scratch / 'observations.json').read_text())
        assert observations['result'] == observed
        if name == 'current':
            assert [f['name'] for f in observations['fixtures']] == ['ordering', 'FINAL-mismatch', 'FINAL-match', 'recovery-ack-write', 'recovery-zero', 'recovery-partial', 'stop-refusal']
    assert all(sha(SOURCE / p) == value for p, value in sourcepins.items())
    assert sha(args.corpus) == CORPUS_SHA256 and sha(SOURCE / corpus['model']['path']) == corpus['model']['sha256']
    assert sha(HERE / 'bind.ts') == receipt['adapter_sha256'] and sha(Path(__file__)) == receipt['runner_sha256'] and sha(bun) == receipt['tool']['sha256']
    receipt['complete'] = True
except Exception as error:
    receipt['error'] = str(error)
finally:
    receipt['not_run'] = [name for name in VARIANTS if name not in {r['name'] for r in receipt['results']}]
    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(run / 'receipt.json', flush=True)
raise SystemExit(0 if receipt['complete'] else 1)
