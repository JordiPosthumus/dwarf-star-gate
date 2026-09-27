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


## Audit 2026-09-24

The staged admission backend and chat schema already existed, but the installed
Hermes bridge never registered the admission toolset. Registration is now fixed
and verified against the installed Python environment. Existing ask-first
workflow remains separate from recipe-trial approval.

`verify_serving` now performs real inference rather than treating `/v1/models`
as generation proof. Real Genie calls and native verification receipts are retained privately. Credential resolution uses the private worker binding;
public worker views intentionally omit credentials. Receipts retain failed
checks as well as later successful evidence.

Still open: one full new-worker admission through the actual Genie, including
route activation and final generation. Do not remove/re-admit a working household
worker merely to manufacture a completion claim. #008 now also has native
status/routing/power controls and an enrolled immutable recipe-trial tool;
#011 remains broader than the single GLM Spark profile being evaluated.


## Admission lifecycle corrections

An integration check using isolated model endpoints, a real gateway core and
Continuity Door exposed two gaps in the prior mocked flow: real registration
starts paused, and a native model needs the gateway's pool-name alias. The
proposal now includes that alias and a separate `resume` stage. Readmission
requires fresh readiness and the registration's operator/maintenance decision
tokens; newer pauses, named holds and direct reservations remain protected.

Completed stages and original registration evidence survive dashboard reload.
An interrupted stage is surfaced with its saved intent and cannot be replayed
or silently replaced. Completed action IDs are deduplicated. A new inspection
cannot replace a proposal while its mutation is in flight.

Validation crosses add → route → real fixture core restart → dashboard-tool
reload → conditional resume → real Door generation with the expected worker
header. Its native fixture rejects an incorrect model name. This proves the
control integration, not admission of another production model. The remaining
production-admission criterion above stays open.
