# Queue waiting and interruption

DSG defaults to **20,000 hours** of queue waiting (`queue_timeout_ms: 72000000000`).
This is a gateway admission deadline, not a DS4 context/output/thinking setting.
The separate default active-request allowance remains **100 hours**. Per-worker
queue admission limits are unchanged. Effective values appear in `/gateway/status`.

An existing private config with an explicit shorter `queue_timeout_ms` continues
to use it until the operator changes it. New setup configs use the new default.
Use **Manage DS4 servers → Queue waiting allowance (hours) → Save queue allowance**.
The control applies immediately to **new admissions** without a restart. Existing
queued requests retain their admission-time deadline, including when you lower
the allowance; the UI asks for confirmation before reducing it. Active generations,
model settings and Pi are untouched. Unsaved typing survives UI polling.

If the queue deadline expires, DSG returns HTTP **504**, code `queue_timeout`,
with the request's admission-time allowance and the location of the UI control:

> This request reached its DSG queue waiting limit of 20,000 hours and was not dispatched to a model server. This limit is configurable in DSG under Manage DS4 servers → Queue waiting allowance (hours); changes apply to new requests.

The duration reflects that request's actual limit, not a hard-coded default or a
later UI change. Shorter custom limits are reported in minutes, seconds or
milliseconds when appropriate. This error confirms no model-server dispatch;
it does not mean a running generation timed out or that the client will retry.

The explicit UI choice is backed up and atomically saved as `queue_timeout_ms` in
the private affinity metadata store. It takes precedence over the startup config
across restarts, just like the explicit pool context limit. The UI displays whether
the value comes from saved state, config or default. Revert using the same control,
not by restoring an old whole-state backup over newer conversations.

The operator Unix socket accepts `/set-queue-timeout` with exactly
`queue_timeout_ms` and `expected_queue_timeout_ms` (positive safe-integer
milliseconds). A stale expected value fails without overwriting the newer choice.
The UI uses the existing loopback-only, same-origin, CSRF-protected control path;
neither the inference listener, scoped worker agents nor Genie can change this
policy. Read effective values from `/gateway/status` or `/workers`.

Per-worker status also reports the oldest current queue age and its remaining
deadline in seconds. Genie receives both for reporting: remaining allowance is
**not** an ETA or proof of a stall. Unknown remains null. Long queues deserve
attention even with a generous deadline. Genie cannot revive a stopped Pi turn.

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
