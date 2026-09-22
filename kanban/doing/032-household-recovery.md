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

- Verify household PoolModel routing and dashboard after restoration.
- Finish power controls using the existing backend; correct fleet_power toggle
  binding and serialize conflicting operations on the same physical machines.

Other agents' existing changes, including card 023, are untouched.
