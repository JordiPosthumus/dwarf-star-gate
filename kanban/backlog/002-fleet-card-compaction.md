# Compact fleet cards (major simplification)
Agreed design (2026-09-21 chat). Cards ~110-150px, grid minmax(440->300).
- Remove the 3 dead lights (Decode/Prefill/Cache Unknown boxes) outright
- Replace with one live line: state + inline rates (decode/prefill) + real cache %
- White "N/M gateway requests active" paragraph -> tiny chip "2/2 · 1q", hidden when idle
- Status dot replaces big verdict label + badge (text to tooltip)
- Requested/actual thinking stays on the face in small text (Jordi likes this)
- DECODE/PREFILL 44px blocks + charts, methodology, hardware strip (RAM/GPU/power/temps)
  -> per-card Details drawer. Charts NOT deleted.
- Temp/power warning chips escalate to the face only on threshold
- New: per-worker cache-hit fraction (prompt-token-weighted) from request-history usage
Files: ui/ui.js (device(), drop performanceLightsMarkup/cacheLight inline use),
ui/ui.css (grid, chips), dashboard.mjs (cache fraction in status snapshot).
