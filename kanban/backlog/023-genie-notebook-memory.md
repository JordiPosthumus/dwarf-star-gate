# Genie memory: operational notebook review
genie_chat has an operational_notebook binding to memory. Verify the Genie actually
records fleet changes (admissions, quarantines, reverts) there so he can brief Jordi
after an absence. File: docs/genie-memory.md.

## VERIFIED (2026-09-22 ~03:45)
genie_chat's operational_notebook binding works via dashboard.mjs (GenieChat
notebook=config.genie_chat.operational_notebook===true?memory:null). The store
wiring is probed: config.local.json has no genie_chat.operational_notebook key →
defaults false → the notebook is NOT in Genie's context today. Enable by setting
genie_chat.operational_notebook=true in config.local.json + dashboard restart.
Decision left to Jordi: opt-in if he wants Genie to cite operational notes
(12-record retrieval, private scope). No code change needed either way.
