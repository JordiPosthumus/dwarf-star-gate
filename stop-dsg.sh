#!/usr/bin/env bash
# Safely stop this checkout's gateway/dashboard; leave model servers alone.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo 'DSG requires Node.js 22.22.2 or newer on PATH. Nothing stopped.' >&2
  exit 1
fi
exec node "$script_dir/ds4-gateway/lifecycle.mjs" stop "$@"
