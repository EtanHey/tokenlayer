#!/usr/bin/env python3
"""Bounded model-only checks; expected current counterexample is NOT product green."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parent
JAR = Path.home() / ".cache/tla/tla2tools.jar"
JAVA = Path("/opt/homebrew/opt/openjdk/bin/java")
JAR_SHA = "fc6878c603f0fdc18b9fe3e5bf51860cb90ab5b1154e3c371660c036d6bdd63e"
SAFETY = "GlobalSingleDispatcher NoPostStopDispatch AdmissionQuiescent CustodyRetained FreshAcknowledgment NoIntentDiscard"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verdict(code, log, kind, name):
    if re.search(r"\bwarn(?:ing)?s?\b", log, re.IGNORECASE):
        return False
    if kind == "pass":
        return code == 0 and "Model checking completed. No error has been found." in log
    marker = (f"Invariant {name} is violated." if kind == "invariant"
              else f"Temporal property {name} was violated.")
    return code == (12 if kind == "invariant" else 13) and marker in log


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new immutable receipt directory")
    args = parser.parse_args()
    if digest(JAR) != JAR_SHA:
        raise SystemExit("unverified jar; no download/repair")
    args.output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    success = "Model checking completed. No error has been found."
    invariant, temporal = "Invariant Expected is violated.", "Temporal property Expected was violated."
    probes = [(12, "Invariant Wrong is violated.", "invariant", False),
              (150, "Parsing error", "invariant", False), (124, invariant, "invariant", False),
              (13, "Temporal property Wrong was violated.", "temporal", False), (0, "", "pass", False)]
    for code, log, kind in [(0, success, "pass"), (12, invariant, "invariant"), (13, temporal, "temporal")]:
        probes += [(code, log, kind, True), (code, "Warning: synthetic warning\n" + log, kind, False)]
    controls = [dict(exit=code, log=log, kind=kind, property="Expected", expected=expected,
                     actual=verdict(code, log, kind, "Expected")) for code, log, kind, expected in probes]
    (args.output / "classifier-probes.json").write_text(json.dumps(controls, indent=2) + "\n")
    if any(c["actual"] != c["expected"] for c in controls):
        raise SystemExit("classifier controls failed; raw probes retained")
    cases = [
        ("current-unfenced", "Current", "none", True, "invariant", "GlobalSingleDispatcher"),
        ("local-safety", "Current", "none", True, "pass", "LocalExclusive"),
        ("local-mutant", "Current", "local", True, "invariant", "LocalExclusive"),
        ("local-reachable", "Current", "none", True, "invariant", "WitnessLocal"),
        ("conditional-safety", "Transfer", "none", True, "pass", SAFETY),
        ("unknown-owner", "Transfer", "none", False, "pass", SAFETY),
        ("early-drain", "Transfer", "drain", True, "invariant", "GlobalSingleDispatcher"),
        ("stop-mutant", "Transfer", "stop", True, "invariant", "NoPostStopDispatch"),
        ("capability-mutant", "Transfer", "capability", True, "invariant", "AdmissionQuiescent"),
        ("custody-mutant", "Transfer", "custody", True, "invariant", "CustodyRetained"),
        ("custody-clear-both", "Transfer", "clear-both", True, "invariant", "NoIntentDiscard"),
        ("stale-ack", "Transfer", "stale", True, "invariant", "FreshAcknowledgment"),
        ("stale-overlap", "Transfer", "stale", True, "invariant", "GlobalSingleDispatcher"),
        ("fair-progress", "Transfer", "none", True, "pass", "HandoffProgress"),
        ("lost-message", "Transfer", "lost-message", True, "temporal", "HandoffProgress"),
        ("source-callback-target", "SourceStop", "none", True, "invariant", "NoPostSignalDispatch"),
        ("source-poll-target", "SourceStop", "none", True, "pass", "NoPostPollDispatch"),
        ("source-poll-mutant", "SourceStop", "poll", True, "invariant", "NoPostPollDispatch"),
        ("proposed-callback-guard", "SourceStop", "callback-guard", True, "pass", "NoPostSignalDispatch NoPostPollDispatch"),
        ("source-await-gap", "SourceStop", "none", True, "invariant", "WitnessAwaitGap"),
        ("proposed-await-stop", "SourceStop", "callback-guard", True, "invariant", "WitnessProposalStop"),
    ]
    cases += [("reach-" + name, "Transfer", "none", name != "UnknownHold",
               "invariant", "Witness" + name) for name in
              ["Stopped", "LateFinish", "HeldTransfer", "Restart", "StaleAck",
               "StaleRelease", "DelayedAck", "UnknownHold", "Accepted", "SuccessfulHeldHandoff"]]
    identity = {"jar": str(JAR), "jar_sha256": digest(JAR), "java": str(JAVA.resolve()),
                "java_version": subprocess.run([str(JAVA), "-version"], capture_output=True,
                                               text=True, timeout=10).stderr,
                "files": {p.name: digest(p) for p in sorted(ROOT.iterdir()) if p.is_file()},
                "source": {p: digest(ROOT.parent.parent / p) for p in
                           ["scripts/history/run.ts", "scripts/history/stream.ts", "scripts/history/source.ts", "scripts/history/README.md", "src/ship/ship.ts"]},
                "classification": "MODEL_ONLY; CURRENT_UNFENCED_AND_CALLBACK_TARGETS_NOT_GREEN; CONDITIONAL_PROPOSAL_ONLY",
                "worker_limit": 1, "heap_mib": 512, "per_case_seconds": 90,
                "total_seconds": 900}
    (args.output / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    results = []
    for case, module, mutant, known, kind, prop in cases:
        directory = args.output / case
        directory.mkdir()
        temporal = prop == "HandoffProgress"
        config = ("SPECIFICATION " + ("FairSpec" if temporal else "Spec") + "\n"
                  + f'CONSTANT Mutant = "{mutant}"\n'
                  + (f"CONSTANT Known = {str(known).upper()}\n" if module == "Transfer" else "")
                  + ("PROPERTY " if temporal else "INVARIANTS ") + prop
                  + "\nCHECK_DEADLOCK FALSE\n")
        cfg = directory / (case + ".cfg")
        cfg.write_text(config)
        model = directory / (module + ".tla")
        model.write_bytes((ROOT / model.name).read_bytes())
        # Check reviewable baseline configs against the generated invocation.
        baselines = {"current-unfenced": "Current.cfg", "conditional-safety": "Conditional.cfg",
                     "source-callback-target": "SourceStop.cfg", "proposed-callback-guard": "ProposedStop.cfg"}
        if case in baselines:
            original = ROOT / baselines[case]
            if original.read_text().split() != config.split():
                raise SystemExit("baseline config drift; expected properties must remain configured")
            cfg.write_text(original.read_text())
        command = [str(JAVA), "-Xmx512m", "-XX:+UseParallelGC", "-cp", str(JAR), "tlc2.TLC", "-workers", "1",
                   "-metadir", str(directory / "states"), "-config", str(cfg), str(model)]
        remaining = 900 - (time.monotonic() - started)
        if remaining <= 0:
            raise SystemExit("whole invocation deadline exhausted")
        before = time.monotonic()
        try:
            run = subprocess.run(command, capture_output=True, text=True, timeout=min(90, remaining),
                                 cwd=directory)
            code, log = run.returncode, run.stdout + run.stderr
        except subprocess.TimeoutExpired as exc:
            code, log = 124, (exc.stdout or b"").decode() + (exc.stderr or b"").decode()
        (directory / "tlc.log").write_text(log)
        counts = re.findall(r"(\d+) states generated, (\d+) distinct states found", log)
        ok = verdict(code, log, kind, prop)
        row = dict(case=case, expected=kind, property=prop, exit=code, matched=ok,
                   classification="PROPOSAL_ONLY" if module == "Transfer" or mutant == "callback-guard" else "SOURCE_PROJECTION_ONLY",
                   states=counts[-1] if counts else None, command=command,
                   config_sha256=digest(cfg), seconds=round(time.monotonic() - before, 3))
        results.append(row)
        (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(f"{case}: exit={code} expected={kind}:{prop} matched={ok} states={row['states']}", flush=True)
        if not ok:
            raise SystemExit("UNMATCHED: retained raw failure; no automatic retry")
    print("MODEL_RECEIPTS_MATCHED; CURRENT_UNFENCED_AND_CALLBACK_TARGETS_NOT_GREEN; PROPOSAL_ONLY; R2_PENDING")


if __name__ == "__main__":
    main()
