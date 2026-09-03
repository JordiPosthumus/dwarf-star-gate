# Client continuity: keep safely waiting clients alive

Status: **pre-dispatch receipts, conversation-scoped reassignment and an opt-in
Pi transport adapter implemented**. Queue relocation and post-dispatch recovery
remain planned. Source availability is not automatic activation in existing Pi sessions.
Raising the [queue allowance](queue-wait.md) removes one failure trigger; it does
not make requests durable or recover a client that has exhausted its own retries.

## Distinct failure paths

- `queue_timeout`: a request expired before dispatch. No inference was started
  for that request. Client retry policy determines whether the turn continues.
- `home_unavailable`: an unavailable **or paused** assigned server still has
  active/queued work for **this conversation**. Unrelated work no longer blocks
  reassignment of an undispatched attempt. A pause is not a broken engine.
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
It uses only isolated fake workers: tool executes once, four certified waits,
then automatic answer continuation. The installed Pi provider composer is also
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

Current Genie can report queue age/remaining allowance and request eligible,
enrolled Spark recovery. It cannot move queued requests, change timeout policy,
resume a stopped Pi turn or restart arbitrary Mac services. Recovery rejects
workers with admitted work and requires supported fatal evidence and identity.
The full end-to-end acceptance test is a real compatible client surviving a
staged failure and continuing its turn without manual intervention—not merely
a restarted service or green model-list endpoint.
