#!/bin/bash
set +x
set -euo pipefail
umask 077
[[ $# == 1 ]] || { echo 'usage: copy-password.sh <hub-ssh-host>' >&2; exit 1; }
for binary in ssh mktemp mkdir chmod mv; do
  command -v "$binary" >/dev/null || { echo "$binary missing from PATH" >&2; exit 1; }
done
dir="$HOME/.config/tokenlayer"
mkdir -p "$dir"
chmod 700 "$dir"
target="$dir/clickhouse.env"
[[ ! -e "$target" && ! -L "$target" ]] || { echo 'credential already exists; reconcile before copying' >&2; exit 1; }
transfer=$(mktemp "$dir/.clickhouse.env.XXXXXX")
trap 'rm -f "$transfer"' EXIT
ssh "$1" cat .config/tokenlayer/clickhouse.env > "$transfer"
[[ -s "$transfer" ]] || { echo 'empty credential transfer refused' >&2; exit 1; }
chmod 600 "$transfer"
mv -n "$transfer" "$target"
[[ ! -e "$transfer" ]] || { echo 'credential appeared during transfer; kept existing file' >&2; exit 1; }
