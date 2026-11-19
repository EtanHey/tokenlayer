#!/bin/bash
set +x
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
BUN=$(command -v bun) || { echo 'bun missing from deploy PATH' >&2; exit 1; }
required=(dirname)
if [[ ${1:-} == hub ]]; then
  required+=(uname mkdir curl shasum mv chmod openssl plutil launchctl tailscale)
elif [[ ${1:-} == ship ]]; then
  required+=(plutil launchctl)
elif [[ ${1:-} == pin ]]; then
  required+=(git tar launchctl)
elif [[ ${1:-} == use ]]; then
  required+=(launchctl)
elif [[ ${1:-} == drift ]]; then
  required+=(plutil)
elif [[ ${1:-} =~ ^(dashboard|fable|hubupdate|jev|ratchet-live|steer|usage)$ ]]; then
  required+=(plutil launchctl)
fi
for binary in "${required[@]}"; do
  command -v "$binary" >/dev/null || { echo "$binary missing from deploy PATH; no changes made" >&2; exit 1; }
done
# Daemons run ~/.config/tokenlayer/app/current, never this checkout (docs/pinned-installs.md).
# pin <sha>: git archive that commit to app/<sha>, bun install --production, flip current; use <sha>: roll back.
if [[ ${1:-} == pin ]]; then
  exec "$BUN" "$REPO/scripts/deploy/pin.ts" install "${@:2}"
elif [[ ${1:-} == use ]]; then
  exec "$BUN" "$REPO/scripts/deploy/pin.ts" use "${@:2}"
fi
# drift [m1|m4]: read-only; each live com.tokenlayer.* plist vs what this tree renders; exit 1 on any difference.
# <job> [m1|m4]: render, lint and reload one job (hub and ship install clickhouse, drain and ship).
if [[ ${1:-} == drift ]]; then
  exec "$BUN" "$REPO/scripts/deploy/jobs.ts" drift "${@:2}"
elif [[ ${1:-} =~ ^(dashboard|fable|hubupdate|jev|ratchet-live|steer|usage)$ ]]; then
  exec "$BUN" "$REPO/scripts/deploy/jobs.ts" install "$@"
fi
# hub/ship never invoke git/xcrun. Pin the official single arm64 binary; verify on EVERY run.
if [[ ${1:-} == hub ]]; then
  [[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || exit 1
  CH="$HOME/.local/bin/clickhouse-d1-26.10.2.103"
  umask 077
  mkdir -p "$HOME/.local/bin"
  if [[ ! -f "$CH" ]]; then
    curl -fsSL https://github.com/ClickHouse/ClickHouse/releases/download/v26.10.2.103-stable/clickhouse-macos-aarch64 -o "$CH.download"
    printf '%s  %s\n' 7f43a3c4d5f41e42ae6ec275c1531ca44b6018caae15217394fd85181ca1df59 "$CH.download" | shasum -a 256 -c -
    mv "$CH.download" "$CH"
  fi
  printf '%s  %s\n' 7f43a3c4d5f41e42ae6ec275c1531ca44b6018caae15217394fd85181ca1df59 "$CH" | shasum -a 256 -c -
  chmod 700 "$CH"
  "$CH" --version
  printf 'bun: %s\nclickhouse: %s\n' "$BUN" "$CH"
  exec "$BUN" "$REPO/scripts/deploy/deploy.ts" hub "$CH"
fi
exec "$BUN" "$REPO/scripts/deploy/deploy.ts" "$@"
