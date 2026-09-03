# Queue waiting and interruption

DSG defaults to **20,000 hours** of queue waiting (`queue_timeout_ms: 72000000000`).
This is a gateway admission deadline, not a DS4 context/output/thinking setting.
The separate default active-request allowance remains **100 hours**. Per-worker
queue admission limits are unchanged. Effective values appear in `/gateway/status`.

An existing private config with an explicit shorter `queue_timeout_ms` continues
to use it until the operator changes it. New setup configs use the new default.
Set the positive integer milliseconds in private config, then perform an approved
gateway restart. UI editing will be added separately; it is not in this first fix.

The implementation chains bounded timers against a monotonic deadline. Passing
20,000 hours directly to Node's `setTimeout` would overflow its 2^31−1 ms limit
and fire almost immediately. Tests advance a fake monotonic clock through the
entire interval, check the boundary, and verify real queued requests/cancellation.

A longer allowance avoids DSG's former one-hour rejection. It is **not a promise
of persistent execution**: queued HTTP requests are in memory, not durable jobs.
Client disconnect, an explicitly interrupted gateway restart, unavailable homes,
and incomplete upstream streams remain separate failure modes. This setting does
not change session-affinity rules or permit replay after output starts. Do not
mistake a long allowed wait for good capacity or a healthy backend.

On macOS the service helper waits for confirmed launchd removal before starting
the replacement registration, avoiding a restart race. It does not operate model
servers. A busy gateway still requires explicit interruption authorization.
