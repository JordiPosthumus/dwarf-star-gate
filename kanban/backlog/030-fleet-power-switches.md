# Fleet power switches: startScripts behind Star Gate UI
~/startScripts contains per-member start/stop/status (m3-control.py, spark-control.py
start|stop <sparks12|sparks34> <glm53f|ds41>, status-*, watch-*).

## BACKEND LANDED (2026-09-22 night, commit ebe0777)
- power-scripts.mjs: allowlist of exact script paths per (worker, action status/
  start/stop); symlink + escape refusal; single-flight per worker/action;
  bounded output capture; 120s timeout (20s status). Scripts stay source of truth.
- genie-power.mjs: chat tool endpoint (/api/genie/power-tools) like recovery tools.
  Status = enrolled scripts + gateway routing view + recent receipts.
  STOP INTERLOCKS: refuse when load>0 or queued>0 ("drain first"); refuse when
  stopping would leave zero healthy workers. Start/stop receipts are script exits,
  never readiness/shutdown proof; next_step guidance says so.
- genie_power.py + genie_hermes.py bridge: Genie gets fleet_power_status and
  fleet_power tools; tool descriptions bake in the ask-first autonomy model
  ("ask the owner in chat BEFORE stopping or starting; the answer in this
  conversation is the approval") and the drain/last-LLM rules.
- genie-capabilities.mjs: new 'fleet_power' switch (per-worker later if asked).
- Tests: genie-power.test.mjs (allowlist, single-flight+receipts, interlocks,
  endpoint auth). npm test 1078 pass / 0 fail.

## REMAINING (UI part b)
- Settings section or per-card power controls (Start/Stop/Status buttons) hitting
  the management endpoint; show script status output; confirm dialog for stop.
- Optionally surface the 'fleet_power' capability row (already in capabilityStatus).