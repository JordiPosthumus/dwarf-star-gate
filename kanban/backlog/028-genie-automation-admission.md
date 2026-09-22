# Genie automation: self-serve worker admission (Jordi's 2026-09-21 ask)
Jordi: "keep in mind that we want to set up the Genie in the next hours/days to handle
this kind of thing automatically for me via chat."
Tonight's manual flow = the recipe the Genie should learn (see done/001):
1. Notice/confirm the endpoint (probe /v1/models, one test generation, context)
2. Drain+remove any dead worker on the same endpoint
3. /add-worker with id/aliases/context/concurrency + api_key_file if needed
4. Add model route in config.local.json (needs park/start restart - door holds calls)
5. Resume, verify generation through the door, report
Genie needs: control-socket tool access (already has /genie-* routes; add admission),
park/start orchestration, and the ask-first conversation per the autonomy model.
Dashboard chat is the first delivery channel. #006 Telegram is optional and
does not block admission. Reuse #030 control operations and #033 hardware mapping.

## PROGRESS (2026-09-22 ~03:50)
Prerequisites now in place from tonight's work:
- Direct-reserve + endpoint telemetry can indicate native/direct activity
  (running>0 + no gate work). This does not
  prove discovery of an unregistered endpoint or identify a new model; admission
  still needs an explicit endpoint/model probe.
- fleet_power tools show enrolled startScripts (status incl. serving engine);
  the admit flow itself (drain dead worker → /add-worker → model route →
  park/start → verify) is the remaining automation. Control-socket routes all
  exist (/add-worker, /edit-endpoint, /remove-worker, /set-direct-reserve,
  /drain-workers, /resume-workers); what's missing is a Genie chat toolset
  binding them with ask-first guardrails + the park/start orchestration.
- Delivery order using dashboard chat now:
  (a) admission-proposal tool (read-only draft), (b) park/start orchestration
  tool with confirmation receipt, (c) self-verify step reusing card 016 checks.
