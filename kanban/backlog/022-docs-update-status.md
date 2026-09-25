# Refresh docs to post-GLM reality
pickuphere.md + docs/roadmap.md disagree with reality (roadmap "way out of date" per
Jordi). Update pickuphere.md after tonight's work; mark roadmap sections retired or
rewrite; record the media pair-placement decision and engine plans.

## PARTIAL (2026-09-22 ~03:20)
- pickuphere.md refreshed (private file, gitignored): fleet state is now
  GLM-first (glm53f-sparks12/34 + glm53f-m3 serving; ds41-m3 paused; qwen sparks
  drained/unhealthy), recent work covers compact cards x3, direct reserve,
  cache telemetry, fleet power backend, thinking levels, bug sweep.
- docs/current-work-plan.md: still accurate for the incremental Genie plan;
  needs a line for direct-reserve + fleet_power switches (capability count 9→10).
- docs/roadmap.md: defer to Jordi — he called it "way out of date"; propose
  marking retired sections rather than rewriting blind.
- Media pair-placement decision (dual-Spark pairs come down together; MiniMax M3,
  LTX, Qwen-Image 2.1 first-class engines) still to record — belongs in
  cards 004/005.


## Updated 24 September 2026

The current work plan now records the ten independent Genie switches, keeps
direct reservation separate, and links the bounded native recipe-trial and
serving-check behavior. The roadmap introduction acknowledges enrolled vLLM/oMLX
workers and clearly labels its detailed DS4 designs as historical scope.
The installation guide already explains durable-registry authority and does not
treat a private-config mismatch as a repair instruction. Private handoff details
and the broader media-engine plans remain installation/feature work; this card
does not claim every historical roadmap section has been rewritten.
