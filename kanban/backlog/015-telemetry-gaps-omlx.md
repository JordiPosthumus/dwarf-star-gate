# oMLX telemetry parity
omlx prefill is "engine-session average incl. overhead" vs vLLM completed-request
accounting; charts empty when idle. Decide: can oMLX report per-request prefill/decode
phases? If yes, wire it; if no, label honestly and drop the empty chart.

## ANSWERED (2026-09-22 ~03:40)
oMLX CAN report per-request phase evidence: /admin/api/activity (after admin
login) exposes per-request prefilling[] (processed/total/speed) and generating[]
(generated_tokens/tokens_per_second). The gate already consumes it
(endpoint-telemetry.mjs omlxActivity + admin session retry); live phases and
live chunk rates now flow. Remaining parity gap is only historical: oMLX has no
completed-request prefill accounting like vLLM's /metrics — the 'engine-session
average incl. overhead' label stays. Empty charts when idle are honest (no
samples); the ACTIVITY strip fills the gap with phase evidence.
Decision: keep the label, keep the charts; no further wiring needed.