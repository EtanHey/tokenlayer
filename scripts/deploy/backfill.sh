#!/bin/bash
set +x
set -euo pipefail
exec "$(dirname "$0")/setup.sh" backfill "$@"
