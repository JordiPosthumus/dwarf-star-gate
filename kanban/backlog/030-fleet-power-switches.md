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
