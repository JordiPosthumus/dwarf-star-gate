#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
config="${DWARF_GATE_CONFIG:-$script_dir/config.local.json}"
runtime="$(node "$script_dir/ds4-gateway/config.mjs" runtime "$config")"
umask 077
mkdir -p -- "$runtime"
echo "Starting gateway in foreground; log: $runtime/gateway.log"
exec node "$script_dir/ds4-gateway/gateway.mjs" "$config" >> "$runtime/gateway.log" 2>&1
