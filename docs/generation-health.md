# Generation failure isolation and recovery

DSG's model/context probe measures API compatibility, **not working GPU
execution**. A DS4 process can answer `/v1/models` while every subsequent
generation fails after a fatal accelerator error.

## Implemented containment

- Recognized fatal accelerator/checkpoint errors in structured HTTP or SSE error
  envelopes quarantine that worker after the request settles. Normal answer text
  quoting an error is not evidence. Observation is bounded and forwards the
  original response unchanged; only enum reasons are persisted, not error text.
- Three operational inference failures without an intervening success also
  quarantine the worker. These include HTTP 5xx, transport failures and incomplete
  streams. Ordinary HTTP 4xx and client cancellation do not increment that count.
  A successful generation resets it; successful model-list probes do not.
- Quarantine persists with the affinity store across gateway restarts. Model-list
  probes and context-setting changes cannot silently reinstate the worker.
  Persistence failure stops new gateway admission and logs an explicit fault.
- No request is automatically replayed. A failed response reaches its caller;
  already queued but undispatched requests receive 503 without execution. After
  outstanding work clears, a client's next request can reassign its session to a
  healthy server under the existing affinity rules. That server may need a cold
  prefill. This is not transparent mid-stream recovery or cache migration.
- A known engine error in an HTTP-200 SSE stream is not a successful training
  sample, even if the stream includes `[DONE]`.
- Completion observation is route-specific: Chat Completions/Completions use
  `[DONE]`, Messages uses `message_stop`, and Responses uses its terminal response
  event. An output-limited Responses event is censored, not an engine failure.
  Explicit failed response/error events count toward operational failure isolation.
  The legacy diagnostic field `sse_done` now means a recognized terminal was
  observed for that route, not necessarily a literal `[DONE]` line.
- If an oversized event exceeds the bounded observer and no terminal can be
  established, record `sse_observation_limited`. Do not increment or reset the
  inference-failure streak, mark a success, or quarantine solely on that missing
  evidence. Bytes still pass unchanged. A separately recognized fatal error still
  quarantines; actual connection failures remain failures. Unknown outcomes are
  excluded from successful-service training.

The current dashboard marks quarantined workers unavailable. Status/diagnostic
JSON and the Genie's briefing include the allowlisted quarantine reason, timestamp
and originating request ID. The [service recovery panel](worker-recovery.md) adds
executor receipts and eligibility reasons. Ordinary manual pause/drain is separate
from quarantine.

## Operator recovery

1. Read the backend's logs and identify the actual failure. Do not assume cache
   corruption or reduce context based on a generic prefill error.
2. For a confirmed fatal CUDA context error, restart only the affected DS4 service
   using the deployment's existing service manager. Preserve the launcher, model
   configuration and disk caches; RAM-resident state necessarily disappears.
   Wait for model loading to finish. Alternatively, use the enrolled, guarded
   [DSG recovery action](worker-recovery.md), which performs restart and checks.
3. Run a real generation and a cold-to-warm continuation check on that isolated
   endpoint. Long-context or vision-specific faults still require their own
   targeted reproduction; a small health check is not a complete certification.
4. Use the existing local operator CLI:

   ```sh
   ./workers.sh resume WORKER_ID
   ```

   For a quarantined worker, resume now requires a fresh compatible model/context
   probe, no active/queued work, and an actual generation of an exact synthetic
   marker. That check uses a 32-token output budget, thinking disabled and a
   20-second deadline **for this check only**. No DS4/Pi defaults are changed.
   Failed verification leaves quarantine intact. Successful verification removes
   quarantine durably and logs `worker_recovery_verified` before routing resumes.
   The socket remains local and operator-only; public inference cannot clear it.

If a worker is removed while quarantined, its fault record is intentionally not
erased by remove/re-add. Re-register the compatible endpoint with the same stable
ID: it remains paused and quarantined until verified `resume` succeeds. No manual
state editing is needed, and re-registration is not a recovery bypass.

## Self-healing boundary

See [bounded worker recovery](worker-recovery.md) for the implemented systemd-user
adapter, opt-in policy, exact-service enrollment, fresh-instance evidence guards,
UI controls, tests and canary procedure. GG and the deterministic fatal-fault
watcher share that runner. Failure to verify leaves the worker isolated; a slow
healthy response is never sufficient evidence. Stream replay, kernel repair and
launchd/container recovery are not implemented. The [broader powers plan](genie-powers-plan.md)
remains a roadmap for additional capabilities.

## Incident evidence — 2026-09-02

A production GB10 worker reported an illegal memory access during a 103,132-token
prefill, after the last reported checkpoint at 38,912 tokens. The kernel recorded
an out-of-range-address exception. Later reset and resumed-prefill errors came
from the same poisoned process while model-list probes continued succeeding.
Restarting that process with unchanged settings restored two test conversations;
each subsequent continuation reused 3,831 of 3,845 prompt tokens. This proves
small-workload recovery, **not the root cause or a long-context kernel fix**.

A second Spark later hit illegal memory access while extending a 37,239-token
checkpoint toward a 43,997-token prompt. The service remained alive, so its
`Restart=on-failure` policy did not recover it; DSG quarantine prevented further
dispatch. Manual recovery retained the launcher/environment/service hashes and
disk cache. The failed process encountered an OOM event during shutdown after
reporting that its RAM checkpoint could not be staged. The replacement passed
two cold conversations and both warm continuations (2,199 of 2,211 prompt tokens
reused each, about 0.4 seconds per continuation), then DSG's recovery marker and
a routed gateway request. This is another recovery observation, **not a fix for
the recurrent CUDA fault or a full-context reliability certification**.

See [NVIDIA's CUDA runtime error documentation](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__TYPES.html)
for the process-relaunch requirement after `cudaErrorIllegalAddress`.
