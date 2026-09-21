# Config backup hygiene
config.local.json.bak-* / .before-* files accumulate in repo root. Move to backups/
with a small script; gitignore them (already ignored but clutter).
