#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
config="${DWARF_GATE_CONFIG:-config.local.json}"
runtime="$(node ds4-gateway/config.mjs runtime "$config")"
umask 077
mkdir -p -- "$runtime"
echo "Starting gateway in foreground; log: $runtime/gateway.log"
exec node ds4-gateway/gateway.mjs "$config" >> "$runtime/gateway.log" 2>&1
