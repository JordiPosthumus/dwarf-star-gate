# Household availability: restore and prevent stale-lock outage

Owner priority, 2026-09-22: restore and maintain functionality for household users.

## Verified restoration — 2026-09-22

Gateway core was unavailable on port 30001. Affinity lock held PID 1130,
which belonged to /usr/libexec/milod after reboot, not a gateway process.
Preserved the stale lock as runtime/affinity.json.lock.stale-20260922T071318.
Affinity state and model settings were unchanged. Existing launchd service
recovered; service-control start timed out before the startup barrier finished,
but subsequent direct checks verified readiness.

Door: core_ready=true, holding=false, held=0. Public /health returned 200.
Both GLM Spark pairs healthy and handling household traffic; at least one
actual request completed successfully, with zero worker failures at observation.
No Spark model process or Door was restarted.

M3 was restored with the unchanged established launcher, in a detached session.
The first launch loaded but exited without a shutdown traceback; launch-session
ownership is suspected, not proven. Detached launch subsequently completed a
real direct inference with HTTP 200 and the expected answer. No model, cache,
context, thinking, concurrency or memory-limit settings were changed.

## Lock fix activated

Locks now record process start time alongside PID. A reused PID with a different
birth identity no longer prevents recovery. Live legacy locks and unreadable
identities remain protected. Existing affinity state is preserved.
199 focused/gateway/service-control tests passed; syntax checks passed.
Activated via coordinated core restart: old requests drained, Door stayed up,
replacement reached readiness, owned hold released. Model servers untouched.

## Remaining work

- M3-specific gateway canary remains unverified: it waited behind existing work
  and reached its test-only 120-second client timeout. Production deadlines were
  unchanged; the existing request was not interrupted. Recheck after it finishes.
- Fleet power implementation is tracked only in #030; it does not keep this
  recovery card open.

Other agents' existing changes, including card 023, are untouched.

## Post-deployment verification

- Normal PoolModel generation through port 30000: HTTP 200, correct answer,
  served by glm53f-sparks12.
- Dashboard workers endpoint: HTTP 200.
- Door: core_ready=true, holding=false, held=0.
- Both GLM Spark pairs and M3 reported healthy. M3 handled an active request;
  no post-restart worker failures were recorded at the verification snapshot.
- Live lock includes PID and process_started_at, confirming new code loaded.
- Published recovery code as 5af750f. The existing notebook-card edit was not
  included. Direct M3 inference passed; queued gateway canary is not claimed passed.

## Completion criteria and priority

Keep this as the only active card until the remaining recovery checks finish:
- [ ] After current work finishes, verify a real M3-specific generation through
  the Door with explicit model routing. Preserve active jobs and production deadlines.
- [ ] Confirm ordinary PoolModel serving, released Door and dashboard availability,
  and that the restored M3 remains alive after its launcher exits.
- [ ] Record current evidence, failures/uncertainty and the loaded release, then
  move this card to done. Use #016's existing checks, not a new monitoring system.

Prior observations above are dated evidence, not a claim of current live health.
