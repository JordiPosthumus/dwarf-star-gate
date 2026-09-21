# Config backup hygiene
config.local.json.bak-* / .before-* files accumulate in repo root. Move to backups/
with a small script; gitignore them (already ignored but clutter).

Done: 2026-09-21 — All config.local.json.before-* snapshots moved to backups/config-local/.
