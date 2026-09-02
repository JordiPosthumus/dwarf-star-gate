#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
exec node ds4-gateway/control.mjs status
