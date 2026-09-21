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

Done: 2026-09-21 — Compact cards live (commit ff60765).
- Dead performance-lights row gone from the card face (function kept for Details drawer)
- White gateway-activity paragraph -> tiny "1/2 · 1q" chip (hidden when idle)
- Status dot + state word replace verdict label + phase badge (text in tooltips)
- Inline live rates on the face; 44px blocks, charts, methodology, hardware, lights
  all moved into a per-card Details drawer (open by default for media/historical cards)
- New cache chip wired to the dashboard cache-usage summary (real cached-fraction)
- Requested/actual thinking kept on the face as small text (Jordi's request)
- Grid minmax 440->300px; refresh-diff updated to the new selectors; dashboard
  restarted (stop/start dashboard only) and serving the new bundle. All tests green.

Round 2 (2026-09-21 morning, Jordi feedback on first screenshot):
- Thinking chip had regressed to large bordered row (brand.css legacy) -> compact chip fixed
- '0m active' hidden unless >= 1 minute
- ACTIVITY bar (phase timeline) now permanently on the face; tensor-parallel pairs
  render two strips (honest: both machines run the same phases; noted in tooltip)
- Small DEC/PRE rate charts permanently on the face, no captions (full blocks in Details)
- Served model ID shown next to the card name (was lost when verdict label was dropped)
