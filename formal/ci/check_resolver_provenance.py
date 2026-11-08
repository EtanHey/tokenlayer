"""D1 jar-provenance regression: fake files/probes/host only; nothing is downloaded or run."""
import copy
import importlib.util
import json
from pathlib import Path
import sys

source, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=False)
spec = importlib.util.spec_from_file_location('resolver_under_test', source)
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)
committed = json.loads(tools.LOCK.read_text())
paths = {'java': root / 'jdk/bin/java', 'jar': root / 'jar', 'bun': root / 'bun'}
paths['java'].parent.mkdir(parents=True)
for key, path in paths.items():
    path.write_bytes(b'synthetic ' + key.encode()); path.chmod(0o700)
(root / 'jdk/release').write_bytes(b'synthetic release')
jar = tools.sha(paths['jar'])
calls = []
def probe(path, flag):
    calls.append(flag)
    return {'exit': 0, 'stdout': 'synthetic bun\n' if flag == '--version' else '',
            'stderr': 'synthetic java\n' if flag == '-version' else '', 'timed_out': False}
tools._probe = probe
protocol = root / 'protocol.json'
tools.LOCK = root / 'common.json'
tools.LOCK.write_text(json.dumps(committed))
results = []
def check(name, fn, expect):
    try:
        observed = fn()
    except Exception as error:
        observed = type(error).__name__ + ':' + str(error)
    results.append({'case': name, 'expected': expect, 'observed': observed, 'matched': observed == expect})
def provenance(profile, protocol_jar):
    protocol.write_text(json.dumps({'jar_sha256': protocol_jar}))
    value = tools.resolve_tools(protocol, profile, paths=paths)
    return [value['status'], value['formal_lane_accepted'], value['sha256']['jar'], value['jar_provenance']]
check('committed-linux-qualification-null', lambda: committed['ci-linux-x64-v1']['qualification'], None)
tools._host = lambda: ('Darwin', 'arm64')
check('local-protocol-pin-provenance', lambda: provenance('local-reviewed', jar), ['VERIFIED_TOOLS_ONLY', False, jar,
      {'protocol_lock_sha256': jar, 'selected_profile_sha256': jar, 'protocol_pin_matched': True}])
check('local-mismatch-refuses-no-substitution', lambda: provenance('local-reviewed', 'f' * 64), 'RuntimeError:JAR_PIN')
check('linux-profile-refused-on-darwin', lambda: provenance('ci-linux-x64-v1', jar), 'RuntimeError:HOST_PROFILE')
tools._host = lambda: ('Linux', 'x86_64')
before = len(calls)
check('linux-null-qualification-refuses', lambda: provenance('ci-linux-x64-v1', jar), 'RuntimeError:UNQUALIFIED')
check('linux-null-refusal-ran-no-probes', lambda: len(calls) - before, 0)
qualified = copy.deepcopy(committed)  # owned fixture only; the committed lock stays null
qualified['ci-linux-x64-v1']['jar'].update(sha256=jar, size=paths['jar'].stat().st_size)
qualified['ci-linux-x64-v1']['qualification'] = {
    'status': 'HOSTED_REVIEWED', 'run_url': 'https://github.com/EtanHey/tokenlayer/actions/runs/1',
    'java_sha256': tools.sha(paths['java']), 'java_version': 'synthetic java\n',
    'bun_sha256': tools.sha(paths['bun']), 'bun_version': 'synthetic bun\n',
    'release_sha256': tools.sha(root / 'jdk/release')}
tools.LOCK.write_text(json.dumps(qualified))
check('linux-protocol-pin-mismatch-exposed', lambda: provenance('ci-linux-x64-v1', 'f' * 64),
      ['VERIFIED_TOOLS_ONLY', False, jar,
       {'protocol_lock_sha256': 'f' * 64, 'selected_profile_sha256': jar, 'protocol_pin_matched': False}])
check('linux-protocol-pin-match-exposed', lambda: provenance('ci-linux-x64-v1', jar), ['VERIFIED_TOOLS_ONLY', False, jar,
      {'protocol_lock_sha256': jar, 'selected_profile_sha256': jar, 'protocol_pin_matched': True}])
check('linux-protocol-without-jar-pin', lambda: provenance('ci-linux-x64-v1', None), ['VERIFIED_TOOLS_ONLY', False, jar,
      {'protocol_lock_sha256': None, 'selected_profile_sha256': jar, 'protocol_pin_matched': False}])
(root / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'scope': 'OFFLINE_SYNTHETIC_RESOLVER_PROVENANCE', 'cases': len(results),
                  'matched': sum(r['matched'] for r in results), 'results': results}))
raise SystemExit(0 if all(r['matched'] for r in results) else 1)
