# Genie memory: operational notebook review
genie_chat has an operational_notebook binding to memory. Verify the Genie actually
records fleet changes (admissions, quarantines, reverts) there so he can brief Jordi
after an absence. File: docs/genie-memory.md.

## VERIFIED (2026-09-22 ~04:15)
- The wiring is real: dashboard.mjs constructs GenieChat with
  `notebook: config.genie_chat.operational_notebook === true ? memory : null`;
  GenieChat.context() retrieves notebook history (12 records / 16 KiB) into the
  chat context when enabled. GenieMemory + its private jsonl store are live.
- config.local.json has NO `genie_chat.operational_notebook` key today →
  defaults false → the notebook is NOT in Genie's context right now.
- To opt in: set `genie_chat.operational_notebook: true` in config.local.json,
  then restart the dashboard (`./stop-dsg.sh --only dashboard && ./start-dsg.sh
  --only dashboard`).
- Decision is Jordi's (privacy trade-off: Genie citing private operational
  history). No code change needed either way.