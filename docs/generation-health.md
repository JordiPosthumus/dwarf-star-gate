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

The current dashboard marks quarantined workers unavailable. Status/diagnostic
JSON and the Genie's briefing include the allowlisted quarantine reason, timestamp
and originating request ID. The dedicated action timeline/evidence drawer is
still roadmap work. Ordinary manual pause/drain is separate from quarantine.

## Operator recovery

1. Read the backend's logs and identify the actual failure. Do not assume cache
   corruption or reduce context based on a generic prefill error.
2. For a confirmed fatal CUDA context error, restart only the affected DS4 service
   using the deployment's existing service manager. Preserve the launcher, model
   configuration and disk caches; RAM-resident state necessarily disappears.
   Wait for model loading to finish. DSG does **not** issue SSH restarts yet.
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
erased by remove/re-add. Recover it before removal, or investigate the stored
state explicitly; deleting a registration must not become a recovery bypass.

## Self-healing boundary

This release **isolates faults automatically**, but does not automatically restart
model servers, replay streams or give the Genie control tools. A future opt-in
recovery runner can perform an allowlisted service restart, with bounded retry
and cooldown, fresh fault evidence, an exclusive per-worker recovery action,
post-restart inference/cache checks and a durable action receipt. If it cannot
verify recovery, keep the worker isolated and notify the operator. Never restart
a healthy but slowly thinking request solely because it is taking a long time.
The deterministic runner should work without an LLM; the Genie can explain and
request permitted actions, not replace the recovery safeguards.

## Incident evidence — 2026-09-02

A production GB10 worker reported an illegal memory access during a 103,132-token
prefill, after the last reported checkpoint at 38,912 tokens. The kernel recorded
an out-of-range-address exception. Later reset and resumed-prefill errors came
from the same poisoned process while model-list probes continued succeeding.
Restarting that process with unchanged settings restored two test conversations;
each subsequent continuation reused 3,831 of 3,845 prompt tokens. This proves
small-workload recovery, **not the root cause or a long-context kernel fix**.

See [NVIDIA's CUDA runtime error documentation](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__TYPES.html)
for the process-relaunch requirement after `cudaErrorIllegalAddress`.
