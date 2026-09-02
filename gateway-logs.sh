#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
config="${DWARF_GATE_CONFIG:-config.local.json}"
runtime="$(node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; console.log(path.dirname(path.resolve(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).state_file)))' "$config")"
exec tail -n 50 -f "$runtime/gateway.log"
