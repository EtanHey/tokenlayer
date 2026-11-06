"""Bounded TLC checks only. No network, product execution, installation or cleanup."""
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
JAVA = Path("/opt/homebrew/opt/openjdk/bin/java").resolve()
JAR = Path.home() / ".cache/tla/tla2tools.jar"
SOURCES = ["scripts/history/stream.ts", "scripts/history/run.ts",
           "scripts/history/source.ts", "src/ship/ship.ts", "src/ship/state.ts"]
SUCCESS = "Model checking completed. No error has been found."


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_result(code, output, kind, prop):
    if re.search(r"\bwarnings?\b|^\s*(?:\*+\s*)?(?:(?:syntax|parse|semantic|tokenmgr)\s*error\b|fatal\s+error\b)\s*:?", output, re.IGNORECASE | re.MULTILINE):
        return False
    violations = re.findall(r"Invariant (\w+) is violated", output)
    errors = re.findall(r"^Error: (.*)$", output, re.MULTILINE)
    if kind == "pass":
        return code == 0 and SUCCESS in output and not errors and not violations
    if kind == "invariant":
        return (code == 12 and violations == [prop] and errors == [
            f"Invariant {prop} is violated.", "The behavior up to this point is:"])
    # This pinned TLC names the violated temporal property; reject generic errors.
    return (kind == "temporal" and prop == "EventuallyAccepted" and code == 13
            and not violations and errors == [f"Temporal property {prop} was violated.",
                "The following behavior constitutes a counter-example:"]
            and "accepted |-> FALSE" in output
            and ("Stuttering" in output or "Back to state" in output))


def self_test():
    trace = "Error: Invariant P is violated.\nError: The behavior up to this point is:\n"
    assert valid_result(12, trace, "invariant", "P")
    for code, text in [(0, trace), (12, trace.replace("P", "Q")),
                       (12, "parse error"), (12, trace + "Error: Deadlock reached.\n")]:
        assert not valid_result(code, text, "invariant", "P")
    assert valid_result(0, SUCCESS, "pass", None)
    assert not valid_result(1, SUCCESS, "pass", None)
    assert not valid_result(0, SUCCESS + "\nError: failure", "pass", None)
    assert not valid_result(13, "Temporal properties were violated.", "temporal", "P")
    temporal = ("Error: Temporal property EventuallyAccepted was violated.\n"
                "Error: The following behavior constitutes a counter-example:\n"
                "accepted |-> FALSE\nState 8: Stuttering")
    assert valid_result(13, temporal, "temporal", "EventuallyAccepted")
    assert not valid_result(13, temporal.replace("EventuallyAccepted", "Other"), "temporal", "EventuallyAccepted")
    assert not valid_result(13, temporal.replace("FALSE", "TRUE"), "temporal", "EventuallyAccepted")
    print("classifier: 12 assertions passed", flush=True)


def cases(manifest):
    rows = [("current-stop", "none", True, "", "invariant", ["StopBeforeDispatch"],
             False, "CURRENT_SOURCE_EXPECTED_VIOLATION")]
    rows += [(name, name, True, "", "invariant", [prop], False, "INTENDED_MUTANT")
            for name, prop in manifest["mutants"].items()]
    rows += [("current-other-safety", "none", True, "", "pass",
              [p for p in manifest["safety"] if p != "StopBeforeDispatch"], False, "CURRENT_SOURCE_BOUNDED_PASS"),
             ("proposal-safety", "none", True, "", "pass", manifest["safety"], True, "PROPOSAL_ONLY"),
             ("progress", "none", False, "", "pass", ["EventuallyAccepted"], False, "NO_FAILURE_PROGRESS"),
             ("stall", "stall", False, "", "temporal", ["EventuallyAccepted"], False, "INTENDED_MUTANT")]
    rows += [("reach-" + goal, "none", True, goal, "invariant", ["WitnessAbsent"], False, "REACHABILITY")
             for goal in manifest["reach"]]
    assert set(manifest["safety"]) == set(manifest["mutants"].values())
    assert manifest["current_source"] == {"StopBeforeDispatch": "EXPECTED_VIOLATION"}
    assert manifest["proposal_only"] == {"RecheckStop": True}
    assert manifest["progress"] == {"baseline": "EventuallyAccepted", "stall": "EventuallyAccepted"}
    assert len({r[0] for r in rows}) == len(rows)
    assert all(re.fullmatch(r"[a-z-]+", r[0]) for r in rows)
    return rows


def config(row):
    name, mutation, faults, goal, kind, props, recheck, label = row
    temporal = name in {"progress", "stall"}
    lines = ["SPECIFICATION " + ("FairSpec" if temporal else "Spec"), "CONSTANTS",
             " Mutation = " + json.dumps(mutation), " Faults = " + str(faults).upper(),
             " Goal = " + json.dumps(goal), " RecheckStop = " + str(recheck).upper(),
             "CHECK_DEADLOCK FALSE"]
    lines += [("PROPERTY " if temporal else "INVARIANT ") + p for p in props]
    return "\n".join(lines) + "\n"


def file_limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024 ** 2, 4 * 1024 ** 2))


def main():
    deadline = time.monotonic() + 900
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--case")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.out is None:
        parser.error("--out is required (new evidence is retained; never overwritten)")
    rows = cases(json.loads((HERE / "checks.json").read_text()))
    if args.case:
        rows = [r for r in rows if r[0] == args.case]
        if not rows:
            parser.error("unknown case")
    args.out.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="run-", dir=args.out))
    env = {k: v for k, v in os.environ.items() if k not in {
        "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"}}
    pins = {str(p): digest(p) for p in [HERE / "Importer.tla", HERE / "checks.json",
            HERE / "check.py", HERE / "toolchain.json", *[ROOT / p for p in SOURCES]]}
    receipt = {"pins": pins, "results": [], "selected_case": args.case,
               "full_suite_complete": False, "scope": "MODEL_ONLY; S2 conformance NOT_RUN"}
    for name in ["Importer.tla", "check.py", "checks.json", "toolchain.json"]:
        (run / name).write_bytes((HERE / name).read_bytes())
    try:
        lock = json.loads((HERE / "toolchain.json").read_text())
        version = subprocess.run([str(JAVA), "-version"], capture_output=True, timeout=5, env=env)
        identity = (version.stdout + version.stderr).decode()
        receipt["tool"] = {"java": str(JAVA), "java_sha256": digest(JAVA),
                           "version": identity, "jar": str(JAR), "jar_sha256": digest(JAR)}
        if version.returncode or identity != lock["java_version"] or digest(JAR) != lock["jar_sha256"]:
            raise RuntimeError("tool identity differs from reviewed lock; no download/repair")
        for row in rows:
            name, mutation, faults, goal, kind, props, recheck, label = row
            case_root = run / name
            case_root.mkdir()
            (case_root / "Importer.tla").write_bytes((run / "Importer.tla").read_bytes())
            cfg, log = run / (name + ".cfg"), run / (name + ".log")
            cfg.write_text(config(row))
            argv = [str(JAVA), "-Xmx512m", "-XX:+UseParallelGC", "-cp", str(JAR), "tlc2.TLC", "-workers", "1",
                    "-seed", "1", "-fp", "0", "-metadir", str(case_root / "states"),
                    "-config", str(cfg), str(case_root / "Importer.tla")]
            seconds = min(90, deadline - time.monotonic())
            if seconds <= 0:
                raise TimeoutError("whole-invocation deadline exhausted")
            result = {"name": name, "argv": argv, "cfg_sha256": digest(cfg),
                      "classification": label, "recheck_stop": recheck,
                      "expected": {"kind": kind, "properties": props}, "timeout_s": seconds}
            with log.open("xb") as stream:
                process = subprocess.Popen(argv, stdout=stream, stderr=subprocess.STDOUT,
                                           env=env, start_new_session=True, preexec_fn=file_limit)
                try:
                    result["exit"] = process.wait(timeout=seconds)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    result["exit"] = process.wait()
                    result["timed_out"] = True
            output = log.read_text(errors="replace")
            result["log_sha256"] = digest(log)
            result["states"] = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found", output)
            result["valid"] = not result.get("timed_out") and valid_result(result["exit"], output, kind, props[0])
            receipt["results"].append(result)
            print(json.dumps(result), flush=True)
            if not result["valid"]:
                raise RuntimeError("unexpected outcome; retain raw trace, remaining cases NOT_RUN")
        if any(digest(Path(p)) != value for p, value in pins.items()):
            raise RuntimeError("source/config/runner changed during run")
        if digest(JAR) != receipt["tool"]["jar_sha256"] or digest(JAVA) != receipt["tool"]["java_sha256"]:
            raise RuntimeError("tool changed during run")
        receipt["complete"] = True
        receipt["full_suite_complete"] = args.case is None
    except Exception as error:
        receipt["error"] = str(error)
        receipt["complete"] = False
    finally:
        receipt["not_run"] = [r[0] for r in rows if r[0] not in {x["name"] for x in receipt["results"]}]
        (run / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print("receipt=" + str(run / "receipt.json"), flush=True)
    if not receipt["complete"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
