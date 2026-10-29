"""Allow bootstrap only with the reviewed judge's exact Git blobs (rows excluded)."""
import subprocess
import sys

REVIEWED = 'e1cd4224f3d6adc84f46c899cf043f5702104667'
# Complete local import closure: table imports run-rows; all other imports are node builtins.
JUDGE_FILES = ('ratchet/table.mjs', 'ratchet/run-rows.mjs', 'ratchet/measure.mjs')


def verify(base):
    for path in JUDGE_FILES:
        expected = subprocess.check_output(['git', 'rev-parse', f'{REVIEWED}:{path}'], text=True).strip()
        actual = subprocess.run(['git', 'rev-parse', '--verify', f'{base}:{path}'], capture_output=True, text=True)
        if actual.returncode or actual.stdout.strip() != expected:
            raise ValueError(f'bootstrap judge differs: {path}')


if __name__ == '__main__':
    try:
        verify(sys.argv[1])
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
