#!/usr/bin/env bash
# Start this checkout's gateway and dashboard, never its DS4 model servers.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo 'DSG requires Node.js 22.22.2 or newer on PATH. Nothing started.' >&2
  exit 1
fi
# Keep the caller's cwd: relative --config paths belong to the caller.
exec node "$script_dir/ds4-gateway/lifecycle.mjs" start "$@"
