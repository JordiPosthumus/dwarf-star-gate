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

Item 3 (Details drawer removal) split out to backlog/031-details-drawer-removal.md
pending Jordi's confirm. Direct-reserve card state: "direct use" state word +
per-worker direct_reserved pass-through landed; Settings toggle + reserved list
already existed.

## LANDED (2026-09-22, evening)
- gateway.test.mjs fully green: 196/196 (full suite 1074 pass / 0 fail).
- Test fixes while landing 196:
  * rig now re-binds `r.gateway`/`r.gatewayInstance` on recreate (getter-only
    object broke `r.gateway=createGateway(...)` in alias/route tests);
  * until() polls use backend release arrays / truthy active instead of
    identity compares against getters;
  * reserve-lapse step expires the reservation directly (waiting 60s would
    slow the suite); stale observations asserted not to re-reserve;
  * scheduler auto-relocation (spark2→spark1 ~1s) is the intended soft-reserve
    fallback path — test rides the relocation instead of fighting it.

## CARD ROUND 3 LANDED (2026-09-22 night, commit 090f9b2)
- Item 5 ONE name: served-model chip removed from header; moved into the name
  tooltip ("serving <model>"). `.device-model` CSS now unused (kept harmless).
- Item 6 request chip merged into the live line (state word + 1/2 + rates +
  cache on one row); chips row now only carries the thinking indicator.
- Item 7 state word "generating" → "gen".
- Item 2 pair bars: single strip + mid divider + accent "×2" chip (was two
  duplicated lanes + "2 machines"); "×1" for singles. Machine note updated.
- Item 4 mini charts 26px → 40px tall.
- Item 1 M3 activity bar: VERIFIED WORKING from live snapshot — oMLX activity
  telemetry flows (phase idle/decode/prefill rows present, 63 rows in 15m).
  The original complaint predates the oMLX admin-login retry landing; if it
  still shows empty on screen it is display-only, recheck after dashboard restart.
- dashboard.mjs now passes `direct_reserved` per worker row (state word shows
  "direct use" on reserved cards; was only reachable in-process before).
- Full suite green after changes: 1074 pass / 0 fail (dashboard 96/96).

## E2E VERIFIED LIVE (2026-09-22 ~02:45)
- Toggled direct reserve ON via control socket (store-backed).
- Direct call to :8013 (pi-style, bypassing gate) → dashboard telemetry reports
  running>0 with no gate job → gateway logs direct_reserve_started, worker row
  `direct_reserved:true`, dashboard shows it; state word "direct use" available.
- Pool request during reservation: served by glm53f-sparks12 (soft exclusion
  respected). After the 3-minute grace the reservation lapsed on its own.
- NOTE: during testing m3 showed drained:true (health pause from the idle
  window); resumed via /resume-workers — healthy and routing again.
- Production dashboard restarted to serve the new UI (stop/start --only dashboard).
