# Compact card round 3 (Jordi feedback, 2026-09-21)
From latest screenshot:
1. M3 card shows no ACTIVITY bar — investigate; oMLX phase telemetry may be absent
   or the timeline renders empty for that card. Must show (grey = idle at minimum).
2. Split bars are byte-identical duplicates — not the intent. Either find real
   per-machine phase evidence or redesign the pair indicator (divider + "×2" chip).
3. Details drawer: Jordi probably doesn't want it at all. Default remove; fold the
   few useful bits (hardware temps?) elsewhere. Confirm exact contents to keep.
4. Mini charts: increase vertical height a bit.
5. Two names in the header (worker id + served model) — keep only ONE.
6. The request chip "1/2" wastes a whole row — merge into the live line.
7. "generating" → "gen".

# Direct reserve (automatic pool removal on direct use) — BACKEND DONE
Approved design (Jordi, 2026-09-21): detection via endpoint telemetry polling
(engine `running>0` while the gate has no dispatched job — no client headers
needed, works for pi/curl/anything bypassing the gate); SOFT exclusion
(prefer-elsewhere, admit if pool would be empty); 3-minute release grace.
Header-based detection (old Q1/Q5) was dropped: direct providers bypass the gate
entirely, so the gate would never see those headers.

Implemented in gateway.mjs:
- `pick()` soft-excludes reserved workers; falls back to all eligible.
- `directReserveEnabled()` (store flag `direct_reserve_enabled`), `directReserved(node,now)`
  (checks `node.directReservedUntil`), `observeDirectActivity()`, `reportDirectActivity(rows)`
  (validates `{id,connected,running,at}`, ≤256 rows, fresh ≤30s; logs `direct_reserve_started`).
- `setDirectReserve({enabled})` control route `/set-direct-reserve` (backs up store,
  clears reservations on disable); `/direct-activity` POST route for the dashboard
  to report fresh endpoint metric rows.
- stats().direct_reserve = {enabled, release_ms, reserved}; worker rows get
  `direct_reserved`; registry exposes direct_reserve_control.
- dashboard.mjs polls report endpoint metrics to the gate when enabled.

Fixes made while landing (all verified by gateway.test.mjs):
- stats() called `directReserved()` without the node argument → TypeError.
- `/direct-activity` route referenced `input` outside the body handler → now parses
  its own JSON body (`{rows:[...]}`) with a 64 KiB cap.
- Test originally used `x-dsg-model` route pinning which requires configured
  model_routes; rewritten to plain soft-reserve admission checks.

Remaining on this card: card round 3 UI items 1–7 above + UI polish for the
direct-reserve toggle/status in the dashboard (index.html/ui.js landed earlier).

## PAUSED STATE (2026-09-21 ~20:35, moving desks)
- All 3 gateway bugs fixed and verified by probe; 195/196 gateway tests pass.
- Test 196 (direct-reserve) still failing: after the first request lands on
  spark2, the scheduler AUTO-RELOCATES the queued second request
  spark2→spark1 (`queued_request_relocated`, actor scheduler) in ~1s, BEFORE the
  until(active===2) assertion can observe spark1 active===1 with spark2 full.
  The feature itself works (soft reserve verified); the TEST needs a redesign:
  either assert the relocation outcome directly (second ends up on spark1 via
  relocate event) or disable automatic relocation in the rig for this test
  (check config knobs: automatic_affinity_rebalance_min_wait_ms / genie
  rebalance; see relocationOffers/eligibleDestination in gateway.mjs).
- probe evidence at the pause: first req → spark2 (soft-reserve avoided spark1);
  queued req relocated to spark1 ~980ms later — behavior correct, timing is the
  test problem.
- No production files touched beyond the three fixes; full suite run NOT yet
  green — do not deploy until 196 passes.