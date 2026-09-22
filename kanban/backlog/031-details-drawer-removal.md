# Details drawer removal (pending Jordi's confirm)
Card 029 item 3: Jordi "probably doesn't want it at all. Default remove; fold the
few useful bits (hardware temps?) elsewhere. Confirm exact contents to keep."

Current Details drawer contents (ui.js `details` in device()):
- Big DECODE/PREFILL metric blocks (rates + methodology + per-metric charts)
- Metric details <details> (endpoint source, methodology paragraphs)
- hardwareMarkup (RAM/GPU/POWER strips) — only when hardware telemetry configured
  (currently NOT configured on any worker, so it renders empty)
- performanceLightsMarkup (open evidence buttons for decode/prefill/cache lights)

Note: the performance-light evidence dialog is separate (kept outside the card
DOM) and would survive drawer removal. Removal should fold hardware temps into
the evidence dialog or the live line, and keep the thinking indicator visible.

Everything else from card 029 landed (see done/029 for the record).
