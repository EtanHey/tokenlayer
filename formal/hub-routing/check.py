#!/usr/bin/env python3
"""MODEL_ONLY: routing assumptions and a proposed controller; no hub operations."""
import argparse, hashlib, json, os, re, signal, subprocess, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SAFETY = "NoRejectedWhileOtherAllowed NoStaleAsCurrent FablePreference SoonestResetFirst SingleWriter"

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def classify(code, log, prop, temporal=False):
    lines = log.splitlines()
    completed = 'Model checking completed. No error has been found.'
    expected = ([f'Error: Temporal property {prop} was violated.' if temporal else f'Error: Invariant {prop} is violated.',
                 ('Error: The following behavior constitutes a counter-example:' if temporal else
                  'Error: The behavior up to this point is:')] if prop else [])
    diagnostics = [line.strip() for line in lines if line.strip() != completed and
                   re.search(r'(?i)\b(?:warn(?:ing)?s?|errors?|fatal|exceptions?)\b|(?:Exception|Error)\b|\bpars(?:e|ing|er)\s+(?:failed|failure)\b', line)]
    summaries = [line.strip() for line in lines if re.match(r'^\d[\d,]* states generated,', line)]
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
    valid &= (code == (13 if temporal else 12) and not completions if prop else
              code == 0 and completions == [completed])
    return bool(valid), counts

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--jar', type=Path, default=Path.home()/'.cache/tla/tla2tools.jar')
    args = ap.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=root))
    started = time.monotonic()
    pins = json.loads((HERE/'toolchain.json').read_text())
    java = Path('/opt/homebrew/opt/openjdk/bin/java').resolve(strict=True)
    jar = args.jar.resolve(strict=True)
    version = subprocess.run([str(java), '-version'], capture_output=True, text=True, timeout=10)
    assert sha(java) == pins['java_sha256'], 'JAVA_BINARY_PIN'
    assert version.returncode == 0 and version.stderr == pins['java_version'], 'JAVA_PIN'
    assert sha(jar) == pins['jar_sha256'], 'JAR_PIN'
    tools = dict(java=str(java), java_sha256=sha(java), jar=str(jar), jar_sha256=sha(jar),
                 java_version=version.stderr, classification='MODEL_ONLY_TARGET_PROPOSAL_CURRENT_NOT_GREEN')
    (run/'tools.json').write_text(json.dumps(tools, indent=2)+'\n')
    for p in HERE.iterdir():
        if p.is_file():
            (run/p.name).write_bytes(p.read_bytes())
    count = "2 states generated, 1 distinct states found, 0 states left on queue."
    probes=[]
    for code, marker, prop, temporal in [
        (0,'Model checking completed. No error has been found.',None,False),
        (12,'Error: Invariant P is violated.\nError: The behavior up to this point is:','P',False),
        (13,'Error: Temporal property P was violated.\nError: The following behavior constitutes a counter-example:','P',True)]:
        for prefix, expected in [('',True),('Warning: synthetic\n',False),('Error: unexpected\n',False)]:
            actual,_=classify(code,prefix+marker+'\n'+count,prop,temporal)
            probes.append(dict(actual=actual,expected=expected))
    for code in (124,150):
        actual,_=classify(code,'Parsing failed\n'+count,'P')
        probes.append(dict(actual=actual,expected=False))
    (run/'classifier-probes.json').write_text(json.dumps(probes,indent=2)+'\n')
    assert all(p['actual']==p['expected'] for p in probes), 'CLASSIFIER_PROBES'
    cases = [("current-"+prop, False, prop) for prop in SAFETY.split()+["NoStrand"]]
    cases += [("target", True, None)]
    cases += [("target-"+p, True, p) for p in
              ["WitnessReleaseInFlight", "WitnessRestartInFlight", "WitnessRetry"]]
    baseline = (HERE/'Current.cfg').read_text().split()
    assert baseline == ('SPECIFICATION Spec CONSTANT Target = FALSE INVARIANTS '+
                        SAFETY+' PROPERTY NoStrand CHECK_DEADLOCK FALSE').split(), 'CURRENT_CFG_DRIFT'
    source = [p for directory in ("fable", "steer", "usage")
              for p in (HERE.parent.parent/"src"/directory).glob("*.ts")]
    source_hashes = {str(p.relative_to(HERE.parent.parent)): sha(p) for p in source}
    (run/"source-hashes.json").write_text(json.dumps(source_hashes, indent=2)+"\n")
    results = []
    for name, target, prop in cases:
        remaining = 900-(time.monotonic()-started)
        if remaining <= 0:
            raise TimeoutError('TOTAL_15_MINUTE_BUDGET')
        case = run/name
        case.mkdir()
        (case/'tmp').mkdir()
        (case/'HubRouting.tla').write_bytes((run/'HubRouting.tla').read_bytes())
        cfg = case/'Case.cfg'
        if target and prop is None:
            cfg.write_bytes((HERE/'Target.cfg').read_bytes())
        else:
            cfg.write_text('SPECIFICATION Spec\nCONSTANT Target='+str(target).upper()+'\n'+
                ('PROPERTY ' if prop=='NoStrand' else 'INVARIANT ')+prop+
                '\nCHECK_DEADLOCK FALSE\n')
        cmd = [str(java), '-Xmx512m', '-XX:ActiveProcessorCount=1', '-XX:+UseParallelGC',
               '-Djava.io.tmpdir='+str(case/'tmp'), '-cp', str(jar),
               'tlc2.TLC', '-workers', '1', '-seed', '1', '-fp', '0',
               '-metadir', str(case/'states'), '-config', str(cfg), str(case/'HubRouting.tla')]
        t0 = time.monotonic()
        with (case/'tlc.log').open('w') as out:
            p = subprocess.Popen(cmd, cwd=case, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True)
            timed_out = False
            try:
                code = p.wait(timeout=min(90,remaining))
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                timed_out = True
                os.killpg(p.pid, signal.SIGKILL)
                code = p.wait()
        log = (case/'tlc.log').read_text()
        assert len(log.encode()) <= 262144, 'BOUNDED_LOG_EXCEEDED'
        ok, counts = classify(code, log, prop, prop=="NoStrand")
        row = dict(name=name, expected_property=prop, exit=code, matched=ok and not timed_out,
                   timeout=timed_out, counts=counts, seconds=round(time.monotonic()-t0,3), command=cmd,
                   model_sha256=sha(case/'HubRouting.tla'),
                   config_sha256=sha(cfg), log_sha256=sha(case/'tlc.log'))
        (case/'receipt.json').write_text(json.dumps(row, indent=2)+'\n')
        results.append(row)
        print(f'{name}: exit={code} matched={row["matched"]} counts={counts}', flush=True)
    assert all(sha(HERE.parent.parent/p)==h for p,h in source_hashes.items()), 'SOURCE_DRIFT'
    assert sha(java)==pins['java_sha256'] and sha(jar)==pins['jar_sha256'], 'TOOL_DRIFT'
    summary = dict(classification='MODEL_ONLY_TARGET_PROPOSAL_CURRENT_NOT_GREEN', results=results,
                   matched=sum(r['matched'] for r in results), total=len(results),
                   seconds=round(time.monotonic()-started,3))
    (run/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print('EVIDENCE', run, flush=True)
    return 0 if summary['matched']==summary['total'] else 1

if __name__=='__main__':
    raise SystemExit(main())
