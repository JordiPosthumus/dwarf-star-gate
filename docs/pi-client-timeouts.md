# Pi clients waiting through DSG

DSG can keep a request queued while its selected worker is busy or unavailable.
The client must also permit that wait. A client abort closes the connection;
DSG cannot turn it into a continuing request or safely replay unknown execution.

For Pi, use its existing **HTTP timeout: disabled** setting, or set this in the
appropriate Pi `settings.json`:

```json
{
  "httpIdleTimeoutMs": 0
}
```

Merge this field into the current settings; preserve other fields. In existing
interactive sessions, run `/reload` after active work finishes. Check for a
project setting or `retry.provider.timeoutMs` override that changes the effective
value. Do not set an SDK timeout directly to zero: SDKs may interpret that as an
immediate deadline.

Pi's session layer uses the HTTP timeout setting for both its HTTP dispatcher
and provider request deadline. In the inspected implementation, zero disables
HTTP idle timers and translates the SDK deadline to 2,147,483,647 milliseconds
(about 24.85 days), the Node timer maximum. This is not mathematical infinity.
Other clients and Pi versions need their own effective-setting verification.

The Continuity Door forwards the gateway's HTTP 102 Processing queue heartbeats
without sending premature final success headers. It also flushes actual backend
response headers as soon as the core supplies them, before a delayed first body
token. Heartbeats can keep compatible idle timers alive; they cannot override an
absolute client deadline. The eventual backend status and body remain intact.

Both pool and fixed-worker requests use the same waiting mechanisms. A fixed
route waits for its specific worker; a pool route has more eligible workers.
Neither selection implies a different client timeout. Server availability,
configured DSG queue/request deadlines and explicit cancellation still apply.
