# Fleet power controls: one shared path for UI and Genie

Pending; next implementation task after household recovery (#032). Done means
an owner can start/stop a configured model from its fleet card or through Genie,
with accurate progress and the same checks in both paths. Existing startScripts
remain authoritative; reuse the backend, do not build a second control system.

## Existing implementation (ebe0777; historical test result: 1078 pass)

- power-scripts.mjs allowlists start/stop/status scripts and captures receipts.
  Current serialization is only per worker/action, not physical machine.
- genie-power.mjs and the Hermes bridge expose status and power tools.
  Current stop checks cover gateway worker load/queue and healthy worker count.
- fleet_power capability exists. Current dashboard binding incorrectly checks
  server_changes. A script exit is not readiness or shutdown proof.

## Required work and acceptance criteria

- [ ] Bind power mutations to fleet_power. Turning that capability off prevents
  Genie power actions even when server_changes is on; turning server_changes off
  alone does not disable enabled fleet power. Keep read-only status available.
- [ ] UI and Genie use the same backend operation. Keep the current conversational
  approval model for Genie; a deliberate UI action supplies the owner's intent.
  Explain affected models/machines before a conflicting switch.
- [ ] Prevent overlapping mutations on the same physical machine or Spark pair,
  including Start versus Stop and different model IDs sharing hardware. Read-only
  status remains available. Release the operation guard only when the operation
  finishes or reports a clear failure; a slow load must not permit a second start.
- [ ] Check every affected worker and native/direct workload before stopping.
  Drain new gateway admissions and let active work finish; preserve deliberate
  pauses and unrelated settings. Refuse to stop the last available LLM. Never
  treat unknown native activity as proof of idle or cancel jobs to force a switch.
- [ ] Verify actual endpoint/model readiness before reporting Started, and actual
  shutdown before reporting Stopped. Show loading/draining/failed/unknown with
  the script's useful error detail. A timeout or script exit alone proves neither.
- [ ] Show all configured models, active ones first, with Start/Stop/Status and
  affected hardware. Distinguish routing pause from stopping the model process.
  Turning on a conflicting model drains/stops its conflict through this same path.

## Validation and production rollout

Focused tests: toggle independence, same-machine alias conflicts, independent
machines, active/direct work, last-LLM preservation, script exit before readiness,
and failed/slow starts. Then exercise a live idle transition and restore its
original serving state while another LLM remains available. Preserve launch
settings and back up any infrastructure edits. Use the Door for core reloads;
do not hold all household traffic for an entire model switch.

Use a small explicit hardware mapping first; #033 reconciles the full catalogue
without blocking the concrete fixes here. Media pair placement remains #005.

## LANDED 2026-09-22 ~14:30 (commits e720fcc, 2c8cdcc, aa64f75)
- fleet_power binding fixed (mutations bound to the fleet_power switch; server_changes no longer gates power; read-only status stays available).
- Physical-machine serialization: mutations single-flight per machine group
  (m3-ultra / spark1+spark2 / spark3+spark4) including Start-vs-Stop and
  different model IDs sharing hardware; a slow load blocks a second start.
- Stop refusals: gateway load/queued, direct_reserved (owner direct use),
  engine-reported running>0 outside gateway accounting (directRunning from
  endpoint telemetry), same-hardware model still holding work, last healthy LLM.
- Real verification: start is 'ready' only when the endpoint answers an
  authenticated model-list request; stop is 'stopped' only when the port no
  longer accepts connections; timeout = unproven (loading may continue) — never
  reported as Started/Stopped. Status receipts are script output only.
- UI: fleet-card Status/Start/Stop strip (management mode) with verified
  progress line, machine-busy disabling, stop confirm dialog explaining pair
  scope; mutations run in the background after a synchronous preflight so the
  5s dashboard POST window is respected.
- Genie uses the same runner/verifier via the power tool endpoint.
- Live: power API returns all 8 enrolled members with machine groups; strip
  served in ui.js/css. Suite 1079 pass / 0 fail at last full run.
- Residual polish (non-blocking): active-models-first ordering is the existing
  card sort; per-card hardware labels come from the existing machine note.

## Reopened verification, 2026-09-24

The historical landed claim above was too broad. Exercising the actual Genie
exposed an unusable dashboard preflight contract, a 15-second chat timeout for
long starts, missing action IDs in receipts, and absent status in the tool schema.
Readiness also accepted any HTTP 200 and shutdown treated network failure as stopped.

The fixes share asynchronous action-ID receipts, require the expected model,
keep hardware serialization during launcher/endpoint verification, preserve read-only
status, and refuse dashboard restart during power work. Stop checks require drained
healthy hardware, fresh native idle telemetry and a healthy separate machine.
The existing production launcher settings are unchanged. Fixture coverage and native Genie-controlled start, serving, cache and
launcher-survival validation are complete; deployment receipts remain private.
Receipt history and action deduplication currently last for the
dashboard process lifetime; this is not a durable operation service.
