# Client continuity: keep safely waiting clients alive

Status: **gateway-side patient waiting, pre-dispatch receipts, conversation-scoped
reassignment and an opt-in Pi transport adapter implemented**. Queue relocation and post-dispatch recovery
remain planned. Source availability is not automatic activation in existing Pi sessions.
Raising the [queue allowance](queue-wait.md) removes one failure trigger; it does
not make requests durable or recover a client that has exhausted its own retries.

## Patient waiting in DSG, without changing Pi

Allowed inference POSTs now wait when no server is ready or the same conversation
still owns work on an unavailable/paused server. DSG keeps the original HTTP
request instead of repeatedly returning `no_healthy_workers` / `home_unavailable`.
An already queued, **never dispatched** request whose worker fails moves into a
recovery waiting area. It retains its original server and deadline; it is not
migrated, replayed, or silently given a new allowance. Independent conversations
can still proceed. Waiting requests for the same conversation cannot overtake one
another or split active ownership.

DSG rechecks waiting eligibility every second and after work settles. Healthy
readiness alone cannot clear quarantine, recovery ownership, an agent hold, or an
operator pause. Parked uploads do not block the existing guarded generation/cache
verification. Removing a worker with parked requests is rejected: readmit the
worker or cancel those requests first. No model service, inference setting or
client configuration is changed by this feature.

Bodies stay on their original streams with backpressure; DSG does not spool
prompts to disk or consume/rewrite them while waiting. Standard HTTP **102
Processing** informational keep-alives are emitted about every five seconds.
They are not a final 200, fabricated model tokens or SSE content. Final upstream
status, body and SSE bytes remain unchanged. These writes also help detect a
disconnected client when a large unread upload has backpressured the socket;
cancellation detection is not necessarily instantaneous. A silent network
partition can still take the OS TCP timeout to detect.

The wait uses the existing UI-configurable allowance (default **20,000 hours**).
It is bounded in request count: existing per-worker queue limits remain, and new
recovery-wait admissions are limited to `max(1, registered servers) ×
max_queued_per_node`. Already admitted jobs are preserved when parked, even if
that temporarily puts recovery waiting above its new-admission bound. Full queues
still return a certified 429; authentication, invalid routes and storage failures
do not become indefinite waits. Model metadata GETs remain fast-failing.

`/gateway/status` publishes `continuity.patient_wait`, `waiting`,
`oldest_wait_seconds` and reason counts. Fleet `queued` includes recovery waiting;
worker `queued` does not, and `recovery_waiting` counts that worker's parked homes.
The dashboard shows a live waiting notice and Genie receives this evidence for
reporting and its existing bounded recovery offers. These are ages, not ETAs.
Private `waiting` events contain identifiers/reasons/timing, never raw text;
`decision.admission_wait_ms` separates time held before initial worker admission.
The completion's `queue_ms` still includes the entire pre-dispatch wait.

This works only **while the same DSG process and client connection survive**.
Client/proxy HTTP deadlines still apply; 102 frames do not promise to extend them.
During gateway shutdown, parked calls receive a certified, prefixed 503 so a
compatible client adapter can retry. Forced termination or an ambiguous socket
loss cannot prove non-execution. DSG cannot revive a Pi turn that already stopped.

## Error attribution

DSG-generated inference/control error messages begin **`DSG Report: `**. Dashboard
API and plain-text errors use the same prefix. Stable error codes and continuity
receipts remain machine-readable. **DS4-generated responses remain verbatim**;
DSG does not put its name on an engine error or certify it as undispatched.

## Distinct failure paths

- `queue_timeout`: a request expired before dispatch. No inference was started
  for that request. Client retry policy determines whether the turn continues.
- Historical `home_unavailable` / `no_healthy_workers` on inference POSTs:
  these formerly exhausted short client retry budgets. They now use patient
  waiting. `no_healthy_workers` still applies to model-metadata GETs. A pause is
  not a broken engine, and unrelated work does not block safe initial reassignment.
- Incomplete stream / missing `finish_reason`: the client did not receive a
  complete protocol response. Check terminal framing and interrupted connections;
  do not attribute it to the queue timer without matching request evidence.

## Implemented contract

Gateway-generated rejections carry HTTP `X-DSG-Dispatch-State: not_dispatched`,
`X-Request-ID` and a version-1 `error.continuity` envelope: request/call IDs,
hashed session, worker, typed reason, dispatch state and retry classification.
`wait_then_retry` is recoverable waiting; `operator_required` is not an automatic
retry instruction. Upstream responses are explicitly stamped `dispatched`, so
an engine error cannot masquerade as a safe retry certificate. Status/UI/Genie
show recent receipts; the opt-in dataset retains allowlisted rejection evidence.
Client call IDs join attempts to later admitted decisions; they are stripped
before DS4. No request/response text is retained by this mechanism.

Reassignment is synchronous with durable affinity update. Same-session active
work retains ownership until it settles, including cancellation in progress;
same-session queued work also blocks a split. An unavailable home with only
unrelated work may yield to a ready server. No active/queued request is moved by
this change. A reassigned home may need cold prefill; cache movement is not implied.

### Opt-in Pi adapter (tested with Pi 0.84.4)

Use an **existing DSG provider** and its exact configured `/v1` URL:

```sh
DSG_PI_PROVIDER=local-ds4 DSG_PI_BASE_URL=http://127.0.0.1:30000/v1 \
  pi -e /path/to/DSG/examples/pi-dsg-continuity.ts
```

The provider name is an example, not a new provider to install. The extension
wraps only that provider's `openai-completions` transport, preserving the model
list, authentication, context/output limits, reasoning and Pi serialization.
No automatic edits to models.json/settings.json or unrelated providers. Existing
custom stream overrides require compatibility review before combining extensions.

The retry loop requires the exact DSG header/envelope and matching call/request
IDs. It resends only immutable JSON text, unchanged, after 5–30 seconds of abortable
backoff. Pi displays a waiting status; Escape cancels. There is no three-attempt
limit in this loop; caller cancellation/deadlines still apply. Request objects,
streaming uploads, other endpoints, generic 500s, connection failures and partial
streams are not automatically replayed by this adapter. Existing Pi/SDK retry
policies outside this transport remain separate; this is not an exactly-once
guarantee across client/gateway crashes. It does not extend a client's own HTTP
deadline, resume an already stopped turn, or move queued work.

`npm run continuity:test` covers certificate validation, cancellation, scope and
settings preservation. For the opt-in **real Pi agent/tool-loop** test, set
`DSG_PI_ROOT` to the installed `@earendil-works/pi-coding-agent` package directory.
It uses only isolated fake workers: one test uses native Pi transport through
gateway-side waiting (including HTTP 102), with no retry extension; another uses
four certified client retries across a global admission drain. In both, the tool
executes once and answer continuation is automatic. The installed Pi provider composer is also
checked to preserve model capabilities. No production model or Pi config is touched.

## Next, in this order

1. Deploy the gateway release and opt-in client adapter as separate, backed-up
   changes. Confirm the provider's model/auth/context/reasoning settings remain
   unchanged and reload existing Pi sessions. The automated real-Pi test uses
   synthetic workers; it is not evidence of recovery from every live engine fault.
2. Follow new receipt reasons and matched call IDs in ordinary traffic. Distinguish
   historical rejected attempts from a client demonstrably still waiting. Review
   remaining HTTP/SDK deadlines and incomplete streams separately; the 20,000-hour
   DSG queue allowance does not govern them. Do not silently change all providers.
3. Add opt-in pre-dispatch queue relocation with exact ownership and deadline
   preservation. Never replay a partially uploaded/dispatched request merely
   because a health probe times out. A long active response is not proof of a stall.
4. Handle post-dispatch failures separately: retain independent guarded recovery,
   prove old execution stopped, and define client-visible stream recovery. Genie
   may request offered remedies; deterministic code enforces safety without an LLM.

Current Genie can report live recovery waiting, queue age/remaining allowance and request eligible,
enrolled Spark recovery. It cannot move queued requests, change timeout policy,
resume a stopped Pi turn or restart arbitrary Mac services. Recovery rejects
workers with active/dispatch-queue work and requires supported fatal evidence and
identity. Parked, undispatched requests are separate so they do not deadlock recovery.
The full end-to-end acceptance test is a real compatible client surviving a
staged failure and continuing its turn without manual intervention—not merely
a restarted service or green model-list endpoint.
