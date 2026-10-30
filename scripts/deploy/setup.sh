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
fi
for binary in "${required[@]}"; do
  command -v "$binary" >/dev/null || { echo "$binary missing from deploy PATH; no changes made" >&2; exit 1; }
done
# Never invoke git/xcrun. Pin the official single arm64 binary; verify on EVERY run.
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
