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

# PRIORITY (built before card round 3): automatic pool removal on direct activity
Jordi works directly against endpoints (esp. glm53f-m3) with pi. Star Gate should
detect an active direct client on an endpoint and temporarily pull that worker from
the pool, restoring it automatically when direct use stops. UI toggle:
"automatic removal from pool upon activity".

## Detection (grounded in today's traffic analysis)
- Direct pi sessions send NO session-affinity headers and NO x-dsg-observer, so they
  arrive as affinity:'none' + traffic_class:'unclassified'.
- Gate Genie reviews are tagged traffic_class:'genie' — already distinguishable.
- Hermes fleet work arrives WITH session keys (affinity existing/new, 100+ today).
- Risk: unclassified + no-session could also be a cron/agent client that omits
  headers. Tonight's data shows distinct usage signatures (large prompts, bursty).

## Design questions (need Jordi's call)
- Q1 Signal: (a) request in flight on the worker with traffic_class unclassified,
  or (b) sustained rate of unclassified no-session finishes (N in M minutes)?
  (a) is instant but flaps per request; (b) needs a threshold.
- Q2 Exclusion behavior: full drain (strict) vs prefer-elsewhere (soft: route new
  work away but admit if the pool would otherwise idle)? Soft avoids stranded fleet.
- Q3 Release timer: how long after the last direct signal before re-admitting
  (cache warmth argues for a grace window, e.g. 2-5 minutes)?
- Q4 Scope: per worker toggle in Settings, or one global toggle? Jordi asked for
  "a toggle" — global with per-worker override later seems right.
- Q5 Do direct sessions send anything identifiable we could key on instead
  (api key, user-agent)? If Jordi's pi direct providers could send a header
  (e.g. x-dsg-observer: owner-direct), detection becomes exact. Cheapest fix:
  add headers:{'x-dsg-observer':'owner-direct'} to the direct provider entries
  in ~/.pi/agent/models.json. Then no heuristics at all.

## Implementation sketch (backend first, UI second)
- gateway.mjs: worker flag directReserved:boolean + lastDirectAt, set on observed
  direct signal; pick()/admission excludes directReserved workers (soft or hard per
  config); timer releases after grace window; log direct_reserve events.
- UI: toggle in Settings (or on the card) + a "reserved for direct use" state on
  the card so it's visible why a worker is out of the pool.
- Tests in gateway.test.mjs for the admission exclusion + release timer.

# Fleet power switches (startScripts in UI)
~/startScripts holds start/stop/status per fleet member (m3-control.py,
spark-control.py start|stop <pair> <model>, status scripts, watch).
Goal: UI elements to turn fleet members on/off without touching scripts.
- Wrapper approach: server_operations config already has per-worker native_url +
  qualification containers (spark1/spark2 entries exist). Add service actions that
  exec the existing scripts (m3-control.py, spark-control.py) with allowlisted args.
- Safety: destructive (stop kills a serving model) — gate behind operator
  confirmation + Genie ask-first; never stop a worker that has active requests
  without drain first; keep the "another LLM stays available" invariant.
- UI: power section per fleet member: Start/Stop/Status, current engine shown.
- Cards: split into backend (script adapter + drain interlock + tests) and UI.