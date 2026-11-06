#!/usr/bin/env python3
"""SPEC_ONLY: local TLC only; never loads any purge module or payload."""
import argparse, hashlib, json, os, re, signal, subprocess, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROPERTIES = {
 "authority": "AuthorityCurrent", "ignore-HOLD": "HoldRespected",
 "source-mutation": "SourceCurrent", "wrong-target": "ExactTarget",
 "partial-backup": "CompleteBackup", "partial-verification": "FullRemoteVerification",
 "restore": "RestoreValidated", "stale-receipt": "ReceiptCurrent",
 "lost-receipt": "ReceiptRetained", "remote-loss": "RemoteDurable"}

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def classify(code, log, prop):
    lines = log.splitlines()
    completed = 'Model checking completed. No error has been found.'
    expected = ([f'Error: Invariant {prop} is violated.',
                 'Error: The behavior up to this point is:'] if prop else [])
    diagnostics = [line.strip() for line in lines if line.strip() != completed and
                   re.search(r'(?i)\b(?:warn(?:ing)?s?|errors?|fatal|exceptions?)\b|(?:Exception|Error)\b|\bpars(?:e|ing|er)\s+(?:failed|failure)\b', line)]
    summaries = [line.strip() for line in lines if 'states generated' in line]
    counts = None
    if len(summaries) == 1:
        match = re.fullmatch(r'(\S+) states generated, (\S+) distinct states found, (\S+) states left on queue\.', summaries[0])
        number = r'(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)'
        if match and all(re.fullmatch(number, v) for v in match.groups()):
            generated, distinct, queued = (int(v.replace(',', '')) for v in match.groups())
            if generated >= distinct > 0 and queued >= 0:
                counts = (generated, distinct)
    valid = counts is not None and diagnostics == expected
    completions = [line for line in lines if line.strip() == completed]
    valid &= (code == 12 and not completions if prop else
              code == 0 and completions == [completed])
    return bool(valid), counts

# Effect mutants deliberately erase a bad input in the same decision transition.
ERASURES = {
 'authority': [('auth','"granted"'), ('epoch','s.receipt.epoch')],
 'ignore-HOLD': [('hold','FALSE')], 'wrong-target': [('target','s.receipt.source.target')],
 'partial-backup': [('receipt.coverage','"full"')],
 'partial-verification': [('receipt.verify','"full"')],
 'restore': [('receipt.restored','TRUE')],
 'stale-receipt': [('backup','s.receipt.backup'), ('manifest','s.receipt.manifest'), ('expired','FALSE')],
 'lost-receipt': [('retained','s.receipt.id')], 'remote-loss': [('remoteAlive','TRUE')]}

def erase(model, mutant):
    old = ' /\\ s\'=[s EXCEPT !.pc=IF Eligible THEN "deleted" ELSE "refused"]'
    assert model.count(old) == 1
    if mutant == 'source-mutation':
        # Exact review A construction, including its passive badPreSource field.
        model = model.replace('receipt |-> [unused |-> TRUE]]',
                              'receipt |-> [unused |-> TRUE], badPreSource |-> FALSE]')
        new = old[:-1] + ', !.badPreSource=Eligible /\\ ~SourceOK,' + \
              ' !.source=IF Eligible THEN s.receipt.source ELSE s.source]'
    else:
        new = old[:-1] + ''.join(', !.'+key+'=IF Eligible THEN '+value+' ELSE s.'+key
                                for key, value in ERASURES[mutant]) + ']'
    return model.replace(old, new)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--evidence', type=Path, required=True)
    args = ap.parse_args()
    root = args.evidence.resolve()
    root.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=root))
    started = time.monotonic()
    pins = json.loads((HERE/'toolchain.json').read_text())
    java = Path('/opt/homebrew/opt/openjdk/bin/java').resolve(strict=True)
    jar = Path.home()/'.cache/tla/tla2tools.jar'
    version = subprocess.run([str(java), '-version'], capture_output=True, text=True, timeout=10)
    assert sha(java) == pins['java_sha256'], 'JAVA_BINARY_PIN'
    assert version.returncode == 0 and version.stderr == pins['java_version'], 'JAVA_PIN'
    assert sha(jar) == pins['jar_sha256'], 'JAR_PIN'
    tools = dict(java=str(java), java_sha256=sha(java), jar=str(jar), jar_sha256=sha(jar),
                 java_version=version.stderr, classification='SPEC_ONLY')
    (run/'tools.json').write_text(json.dumps(tools, indent=2)+'\n')
    for p in HERE.iterdir():
        if p.is_file():
            (run/p.name).write_bytes(p.read_bytes())
    cases = [('hold', None, None, True, True), ('permitted', None, None, False, True)]
    cases += [('mutant-hold-no-deletion', 'ignore-HOLD', 'NoDeletion', True, True)]
    cases += [('mutant-'+m, m, prop, m=='ignore-HOLD', m!='remote-loss')
              for m, prop in PROPERTIES.items()]
    witnesses = list(PROPERTIES) + ['success','refusal','sealed','unknown','failed',
                                    'backup-drift','manifest-drift','expiry','signed-off-refused',
                                    'source-drift-refused','unknown-refused','partial-refused']
    cases += [('reach-'+w, None, 'Unseen', False, w!='remote-loss') for w in witnesses]
    cases += [('erase-'+m, m, prop, m=='ignore-HOLD', m!='remote-loss')
              for m, prop in PROPERTIES.items()]
    results = []
    for name, mutant, prop, hold, durable in cases:
        remaining = 900-(time.monotonic()-started)
        if remaining <= 0:
            raise TimeoutError('TOTAL_15_MINUTE_BUDGET')
        case = run/name
        case.mkdir()
        (case/'tmp').mkdir()
        model = (run/'BackupBeforeDelete.tla').read_text()
        (case/'BackupBeforeDelete.tla').write_text(erase(model, mutant) if name.startswith('erase-') else model)
        cfg = case/'Case.cfg'
        if name in ('hold','permitted'):
            cfg.write_bytes((HERE/('Hold.cfg' if hold else 'Permitted.cfg')).read_bytes())
        else:
            cfg.write_text('SPECIFICATION Spec\nCONSTANTS InitialHold='+str(hold).upper()+
              ' AssumeRemoteDurability='+str(durable).upper()+' Mutant='+json.dumps(mutant or 'none')+
              ' Witness='+json.dumps(name[6:] if name.startswith('reach-') else 'none')+
              '\nINVARIANT '+prop+'\nCHECK_DEADLOCK FALSE\n')
        cmd = [str(java), '-Xmx512m', '-XX:ActiveProcessorCount=1', '-XX:+UseParallelGC',
               '-Djava.io.tmpdir='+str(case/'tmp'), '-cp', str(jar),
               'tlc2.TLC', '-workers', '1', '-seed', '1', '-fp', '0',
               '-metadir', str(case/'states'), '-config', str(cfg), str(case/'BackupBeforeDelete.tla')]
        t0 = time.monotonic()
        with (case/'tlc.log').open('w') as out:
            p = subprocess.Popen(cmd, cwd=case, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True)
            timed_out = False
            try:
                code = p.wait(timeout=min(90,remaining))
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(p.pid, signal.SIGKILL)
                code = p.wait()
        log = (case/'tlc.log').read_text()
        assert len(log.encode()) <= 262144, 'BOUNDED_LOG_EXCEEDED'
        ok, counts = classify(code, log, prop)
        row = dict(name=name, expected_property=prop, exit=code, matched=ok and not timed_out,
                   timeout=timed_out, counts=counts, seconds=round(time.monotonic()-t0,3), command=cmd,
                   model_sha256=sha(case/'BackupBeforeDelete.tla'),
                   config_sha256=sha(cfg), log_sha256=sha(case/'tlc.log'))
        (case/'receipt.json').write_text(json.dumps(row, indent=2)+'\n')
        results.append(row)
        print(f'{name}: exit={code} matched={row["matched"]} counts={counts}', flush=True)
    assert sha(java)==pins['java_sha256'] and sha(jar)==pins['jar_sha256'], 'TOOL_DRIFT'
    summary = dict(classification='SPEC_ONLY', results=results,
                   matched=sum(r['matched'] for r in results), total=len(results),
                   seconds=round(time.monotonic()-started,3))
    (run/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print('EVIDENCE', run, flush=True)
    return 0 if summary['matched']==summary['total'] else 1

if __name__=='__main__':
    raise SystemExit(main())
