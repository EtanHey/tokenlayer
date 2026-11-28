#!/usr/bin/env python3
"""MODEL_ONLY: routing assumptions and a proposed controller; no hub operations."""
import argparse, hashlib, json, os, platform, re, signal, subprocess, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SAFETY = "NoFailWhileOtherAllowed NoKnownRejectedFirstTry NoStaleAsCurrent NoFalseActive FablePreference SoonestResetFirst SingleWriter"
TEMPORAL = {"NoStrand", "ConvergesWhenFresh"}

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def classify(code, log, prop, temporal=False):
    lines = log.splitlines()
    completed = 'Model checking completed. No error has been found.'
    diagnostic_property = "NoFailWhileOtherAllowed" if prop=="NoStrand" and code==12 else prop
    expected = ([f'Error: Temporal property {prop} was violated.' if temporal and code==13 else f'Error: Invariant {diagnostic_property} is violated.',
                 ('Error: The following behavior constitutes a counter-example:' if temporal and code==13 else
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
    valid &= (code in ({12,13} if temporal else {12}) and not completions if prop else
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
    pin = next((p for p in pins['java_pins'] if sha(java)==p['sha256'] and
                version.returncode==0 and version.stderr==p['version']), None)
    assert pin is not None, 'JAVA_HOST_PIN'
    assert sha(jar) == pins['jar_sha256'], 'JAR_PIN'
    tools = dict(machine=platform.node(), host_pin=pin['host'], java=str(java), java_sha256=sha(java), jar=str(jar), jar_sha256=sha(jar),
                 java_version=version.stderr, classification='MODEL_ONLY_CURRENT_COUNTEREXAMPLES_TARGET_CHECKS_AND_DESIGN_FINDINGS')
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
    # Target baseline failures are DESIGN_FINDING, never expected-green receipts.
    cases = [("current-"+p, False, "routing", p, True, "violation") for p in
             ["NoFailWhileOtherAllowed", "FablePreference", "SoonestResetFirst", "SingleWriter"]]
    cases += [("current-"+p, False, "telemetry", p, True, "violation") for p in
              ["NoStaleAsCurrent", "NoFalseActive"]]
    cases += [("current-incident", False, "incident", "WitnessIncident", True, "violation")]
    cases += [("current-"+p,False,"routing",p,True,"violation") for p in
              ["WitnessAutoRetains","WitnessStoppedExclusions","WitnessCapFailure"]]
    cases += [("target-combined", True, "routing", "SoonestResetFirst", True, "pass")]
    cases += [("target-"+p, True,
               "handover" if p=="SingleWriter" else "known" if p=="NoKnownRejectedFirstTry" else "progress" if p=="NoStrand" else "telemetry" if p in
               {"NoStaleAsCurrent","NoFalseActive"} else "routing", p, True, "pass")
              for p in SAFETY.split()+["NoStrand"]]
    cases += [("target-restart-NoStrand",True,"restart","NoStrand",True,"pass"),
              ("release-no-restart-NoStrand",True,"release-no-restart","NoStrand",True,"pass")]
    cases += [("target-converges",True,"convergence","ConvergesWhenFresh",True,"pass"),
              ("reliable-release-converges",True,"convergence-reliable","ConvergesWhenFresh",True,"pass"),
              ("no-release-control",True,"convergence-reliable","ConvergesWhenFresh",False,"violation")]
    cases += [("target-"+p, True, "release" if "Reset" not in p else "routing",p,True,"violation")
              for p in ["WitnessReleaseInFlight","WitnessReleaseCompleted","WitnessReloadInFlight","WitnessRestartInFlight",
                        "WitnessEnableFailure","WitnessDisableFailure","WitnessResetBound"]]
    cases += [("mutant-handover", True, "handover", "SingleWriter", True, "violation"),
              ("mutant-stale-display", True, "telemetry", "NoStaleAsCurrent", True, "violation"),
              ("mutant-false-active", True, "telemetry", "NoFalseActive", True, "violation")]
    source = [p for directory in ("fable", "steer", "usage")
              for p in (HERE.parent.parent/"src"/directory).glob("*.ts")]
    source_hashes = {str(p.relative_to(HERE.parent.parent)): sha(p) for p in source}
    (run/"source-hashes.json").write_text(json.dumps(source_hashes, indent=2)+"\n")
    results = []
    for name, target, scenario, prop, release, expected in cases:
        remaining = 900-(time.monotonic()-started)
        if remaining <= 0:
            raise TimeoutError('TOTAL_15_MINUTE_BUDGET')
        case = run/name
        case.mkdir()
        (case/'tmp').mkdir()
        model=(run/'HubRouting.tla').read_text()
        changes={
          "mutant-handover": ('!.fable=FALSE, !.steer=FALSE, !.owner="new"',
                               '!.fable=TRUE, !.steer=FALSE, !.owner="new"'),
          "mutant-stale-display": ('IF Target THEN s.age[a][m]=0 ELSE TRUE', 'TRUE'),
          "mutant-false-active": ('IF Target THEN Fresh(a,"Other") ELSE TRUE) /\\', 'TRUE) /\\')}
        if name in changes:
            old,new=changes[name]
            assert model.count(old)==1, 'MUTANT_DRIFT'
            model=model.replace(old,new)
        (case/'HubRouting.tla').write_text(model)
        cfg = case/'Case.cfg'
        cfg.write_text('SPECIFICATION Spec\nCONSTANTS Target='+str(target).upper()+
            ' Scenario='+json.dumps(scenario)+' ReleaseEnabled='+str(release).upper()+'\n'+
            ('PROPERTY ' if prop in TEMPORAL else 'INVARIANT ')+prop+'\nCHECK_DEADLOCK FALSE\n')
        if name=='target-combined':
            cfg.write_bytes((run/'Target.cfg').read_bytes())
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
        violation, counts = classify(code, log, prop, prop in TEMPORAL)
        passed, _ = classify(code, log, None)
        finding = expected=="pass" and violation and not timed_out
        ok = passed if expected=="pass" else violation
        row = dict(name=name, scenario=scenario, release_enabled=release, expected_property=prop, expected=expected, design_finding=finding, exit=code, matched=ok and not timed_out,
                   timeout=timed_out, counts=counts, seconds=round(time.monotonic()-t0,3), command=cmd,
                   model_sha256=sha(case/'HubRouting.tla'),
                   config_sha256=sha(cfg), log_sha256=sha(case/'tlc.log'))
        (case/'receipt.json').write_text(json.dumps(row, indent=2)+'\n')
        results.append(row)
        print(f'{name}: exit={code} matched={row["matched"]} counts={counts}', flush=True)
    assert all(sha(HERE.parent.parent/p)==h for p,h in source_hashes.items()), 'SOURCE_DRIFT'
    assert sha(java)==pin['sha256'] and sha(jar)==pins['jar_sha256'], 'TOOL_DRIFT'
    summary = dict(classification='MODEL_ONLY_CURRENT_COUNTEREXAMPLES_TARGET_CHECKS_AND_DESIGN_FINDINGS', results=results,
                   matched=sum(r['matched'] for r in results), total=len(results),
                   design_findings=[r['name'] for r in results if r['design_finding']],
                   invalid_runs=[r['name'] for r in results if not r['matched'] and not r['design_finding']],
                   seconds=round(time.monotonic()-started,3))
    (run/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print('EVIDENCE', run, flush=True)
    return 0 if summary['matched']==summary['total'] else 1

if __name__=='__main__':
    raise SystemExit(main())
