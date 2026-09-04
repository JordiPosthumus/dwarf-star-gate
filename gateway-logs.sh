#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
config="${DWARF_GATE_CONFIG:-$script_dir/config.local.json}"
runtime="$(node "$script_dir/ds4-gateway/config.mjs" runtime "$config")"
exec tail -n 50 -f "$runtime/gateway.log"
