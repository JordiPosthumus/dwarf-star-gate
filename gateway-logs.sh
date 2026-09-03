#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
config="${DWARF_GATE_CONFIG:-config.local.json}"
runtime="$(node ds4-gateway/config.mjs runtime "$config")"
exec tail -n 50 -f "$runtime/gateway.log"
