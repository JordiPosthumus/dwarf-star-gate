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
Blocks on: 006 (Telegram) for proactive chat, or dashboard chat now.
