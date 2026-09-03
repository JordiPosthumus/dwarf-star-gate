# Cache-preserving calibration

Implemented: **read-only preflight/status, no generation runner**.
`GET /gateway/status` includes `calibration`; Genie sees the same evidence and the
dashboard shows the skip reason. Current servers fail closed with
`no_verified_non_displacing_adapter`; idle does not make this an approval. No
calibration request, restart, eviction or hourly timer starts.

Per-worker reasons also identify work, pause, quarantine, unhealthiness and
gateway draining. Unverified direct-client exclusion and warm-cache preservation
remain explicit. Caller-supplied “cache safe” flags grant nothing. Training on
existing observations remains independent.

## Execution contract to build next

Manual and optional hourly development runs must share one guarded executor;
default off, and a timer is not permission. Prefer a separately provisioned
calibration-only DS4 instance with exclusive access and verified resources.
“Different port” or “idle gateway slot” proves neither isolation nor free memory.

An adapter needs real stock-DS4 tests proving no production KV displacement,
accelerator/memory competition or unseen direct-client races. Operator assertions,
GG opinions, assigned-session counts, maximum hot slots, cancellation and short
prompts do not substitute for proof. No engine patch or restart to make room is
authorized by calibration. Without a safe adapter, keep skipping.

Acquire an exclusive short-lived reservation, then immediately recheck current
worker/process/profile identity, isolation, allowed model, competing work and
cost budget. Stale preflight is not a capability. Unsupported reservation
semantics, unknown epochs, stale observations or disconnected monitors fail closed.

A versioned operator-approved workload envelope bounds prompt/output/time and
run count **for synthetic jobs only**, never normal launchers. Record workload
version, actual costs, outcome, proven cache regime and execution/skip receipts.
Do not label timeouts as short successful jobs or mix repeated synthetic fixtures
into production gates as independent user sessions.

Release a reservation after cancellation only when the engine demonstrably stops.
Retain unresolved ownership on ambiguity; do not restart production for cleanup.
UI states: attempted/running/verified/skipped/unresolved, backed by actual receipts.

Tests: idle-but-warm, busy/queued, direct-client races, stale process/profile,
paused/quarantined, isolation failure, overlapping manual/hourly attempts,
reservation expiry, disconnect/cancellation, budgets/truncation, real production
cold-to-warm hits before/after, and separate training labels. Until a supported
adapter passes, preflight stays non-executable. See [integration](ds4-integration.md)
and [memory](genie-memory.md) for recording experiments and skips.
