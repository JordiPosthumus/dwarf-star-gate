# Next reliability slice: keep waiting clients alive

Status: **planned, except the queue allowance/control and queue-age reporting**.
Raising the [queue allowance](queue-wait.md) removes one failure trigger; it does
not make requests durable or recover a client that has exhausted its own retries.

## Distinct failure paths

- `queue_timeout`: a request expired before dispatch. No inference was started
  for that request. Client retry policy determines whether the turn continues.
- `home_unavailable`: an unavailable **or paused** assigned server still has
  outstanding work. The current guard is worker-wide, not conversation-specific;
  unrelated work can prevent a safe new assignment. A pause is not a broken engine.
- Incomplete stream / missing `finish_reason`: the client did not receive a
  complete protocol response. Check terminal framing and interrupted connections;
  do not attribute it to the queue timer without matching request evidence.

## Implement next, in this order

1. Record privacy-safe rejection receipts with request/session correlation,
   explicit reason (pause, probe failure, quarantine, same-conversation activity),
   dispatch status and a stable retry classification. Expose queue age, deadline
   risk and the actual recovery block to Genie/UI. No invented ETAs or crash claims.
2. Test conversation-scoped admission reassignment: unrelated old-home work must
   not block a provably undispatched retry, while an active/queued **same-session**
   call must never split across devices. Preserve atomic home assignment and
   ordering; test cancellation, concurrent retries, pause/holds and store failures.
   Cache loss/cold prefill on a new home must be disclosed, not promised free.
3. Add opt-in pre-dispatch queue relocation with exact ownership and deadline
   preservation. Never replay a partially uploaded/dispatched request merely
   because a health probe times out. A long active response is not proof of a stall.
4. Provide a tested Pi/client adapter that treats typed *not dispatched* responses
   as recoverable waiting: abortable backoff/readiness checks, visible status and
   automatic continuation, without re-running completed tool calls. Generic
   clients may still use their own finite retries. Do not silently alter all Pi
   providers or blindly replay partial output/tool-call fragments.
5. Handle post-dispatch failures separately: retain independent guarded recovery,
   prove old execution stopped, and define client-visible stream recovery. Genie
   may request offered remedies; deterministic code enforces safety without an LLM.

Current Genie can report queue age/remaining allowance and request eligible,
enrolled Spark recovery. It cannot move queued requests, change timeout policy,
resume a stopped Pi turn or restart arbitrary Mac services. Recovery rejects
workers with admitted work and requires supported fatal evidence and identity.
The full end-to-end acceptance test is a real compatible client surviving a
staged failure and continuing its turn without manual intervention—not merely
a restarted service or green model-list endpoint.
