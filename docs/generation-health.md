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

The dashboard always shows routing state on each server card, outside collapsed
management controls. Quarantine is labelled **QUARANTINED · NOT ROUTING**, with
the recorded failure reason/time and a **Verify & readmit** button. An overview
warning lists excluded servers. Ordinary operator pause, agent reservation,
unavailable endpoint and quarantine are distinct states, not interchangeable
“idle” or “unavailable” labels.

**Pause routing** stops new admission while admitted work finishes; **Resume
routing** reverses the pause after readiness checks. Neither stops or starts DS4.
**Verify & readmit** uses the existing checked operator-resume path below, not a
blind quarantine reset. It asks for confirmation before generating the small
verification response. Failed checks leave the exclusion intact. Agent holds and
in-progress recovery cannot be bypassed by these buttons; the owning agent must
release its hold. Controls are disabled while live status/control access is lost.
Normal polling preserves card-button focus and tooltips.

Status/diagnostic JSON and the Genie's briefing include the allowlisted quarantine
reason, timestamp and originating request ID. The separate
[service recovery panel](worker-recovery.md) supplies guarded **restart** actions
for enrolled installations; **Verify & readmit** does not restart a model server.

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

## Failure patterns to diagnose

A fatal CUDA execution error can leave the process alive and its model-list
endpoint responsive while later prefill/reset operations fail. A service manager's
`Restart=on-failure` cannot repair that condition if the process never exits.
Quarantine must therefore depend on generation evidence, not only reachability.

Collect the current service invocation and bounded accelerator/kernel evidence
privately. An illegal address, allocation failure and an OOM during shutdown are
different observations; their causal relationship must not be guessed from a
generic checkpoint error. Saving resident state during shutdown can itself need
memory. Preserve disk caches and configuration while investigating.

After a justified restart, require correct generation and real cold-to-warm
reuse before reinstatement. A small successful check is not a long-context kernel
fix. Keep machine-specific chronology and measurements outside the public repo;
contribute minimal reproductions and sanitized failure mechanisms instead.

See [NVIDIA's CUDA runtime error documentation](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__TYPES.html)
for the process-relaunch requirement after `cudaErrorIllegalAddress`.
