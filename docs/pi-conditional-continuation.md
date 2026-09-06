# Pi conditional continuation contract

This is the proposed client API needed by [Proactive Resume](pi-integration-plan.md).
It is not implemented by Pi 0.84.4 and does not enable automatic continuation.
The API belongs inside the client that owns input, queues, session storage and
execution. An extension cannot reproduce it by polling idle state or wrapping
only its own send calls.

## Evidence driving the contract

The real-Pi contract fixture holds a human prompt inside an asynchronous `input`
handler. During that interval Pi reports `isIdle: true`, zero pending messages,
no new transcript entry and no model request. After release the human prompt runs
exactly once. A fence updated only at `agent_start`, transcript append or the
next heartbeat would therefore miss input already admitted by the client.

The same fixture separately proves that deferred custom `nextTurn` messages are
absent from the public pending count and that identical custom proposal details
can trigger another turn. All three require client-owned state.

## Proposed API

Names below are a versioned proposal, not callable APIs in the installed SDK.

| Operation | Result and authority |
| --- | --- |
| `getContinuationCapability()` | Protocol version and supported guard classes; absence means advisory only |
| `inspectContinuation(enrollmentId)` | An opaque short-lived review ticket bound to the current settled state; no ticket if input preparation or any other work is pending |
| `acceptContinuation(ticket, proposal)` | A durable accepted, rejected or unknown receipt; retries with the same proposal ID return its receipt |
| `getContinuationReceipt(proposalId)` | Reconcile acknowledgement loss without issuing a new continuation |
| `revokeContinuation(enrollmentId)` | Revoke new acceptance immediately and invalidate outstanding tickets |

Enrollment is local, off by default, and separate from inference credentials,
Agent Watch and Priority Lens. It identifies the controller, DSG endpoint,
session and already-authorized task scope. It explicitly grants bounded context
review and names the Genie provider. Revocation does not abort ordinary work or
silently change native retry, model, thinking, output or cache settings.

The client owns ticket fields: process epoch, session/branch identity, settlement
generation, admission revision, enrollment revision, task-scope revision,
expiration and attempt budget. A model cannot supply or alter these values.
Tickets contain no raw transcript. Task text and Genie output never create
consent or expand authority.

A proposal contains a unique ID, ticket reference, bounded explanation and one
supported class: `courtesy_check_in` or `settled_outage`. The client constructs
the fixed visible Gate Genie cue; free-form model output is never executed as a
command. Outage proposals additionally require positive execution evidence;
unknown dispatch, outstanding tools or unresolved native retry cannot pass.

## Acceptance boundary

1. Advance the admission revision synchronously at every input entry point,
   before any awaited command, extension hook, template or provider preparation.
   Count preparation until that operation exits, including errors and handled
   commands. Human input, stops, queue writes, deferred custom context, bash,
   compaction, retry, session switches and competing controllers invalidate
   outstanding tickets. Existing input must continue normally.
2. Check current enrollment, task scope, expiry, epoch and revisions. Check all
   queues and preparations owned by the client, not just the displayed steering
   and follow-up count. Active work, completed tasks, human decisions, user stops
   and unresolved execution produce a visible rejection reason.
3. Reserve the proposal and generation in the client's durable journal. Repeated
   delivery cannot claim another attempt; a different controller or proposal for
   that generation cannot claim it either. Journal failure rejects acceptance.
4. Recheck revisions after awaited persistence. New human input must not wait
   behind journal I/O. A pending reservation is not permission to disregard a
   stop or input that arrived during that I/O.
5. In the same client-owned serialized admission operation, record the durable
   execution intent and claim the turn. No await or external callback may occur
   between the final state comparison and the turn claim. If durable intent must
   precede an asynchronous step, recheck afterward and persist a rejected receipt
   when invalidated. A restart with unresolved intent is `unknown`; never replay
   automatically. A new process epoch invalidates old review tickets.
6. Submit exactly one labelled custom cue through the owning session. Attribute
   Gate Genie in both rendered history and model context. The cue permits only
   continuation of the enrolled task, not approval of a human decision.

A synchronous turn claim is not a global lock on user interaction. Input or a
stop arriving afterward retains the normal client semantics. No extra retry,
queue draining, input dropping, history replacement or process restart is part
of this API. An implementation must audit direct SDK and agent access as well
as extension entry points; unsupported mutation paths prevent certification.

## Receipt and progress contract

Use `reserved → rejected | accepted → progress_confirmed | failed | unknown`.
Retain one durable receipt per proposal and consumed generation. A receipt binds
the custom cue to the resulting turn and subsequent execution evidence. Starting
a request proves acceptance, not useful progress or completion. A lost
acknowledgement is resolved by receipt lookup. A crash between intent and a
provable result remains unknown and blocks automatic replay. Bound attempts per
authorized task so a fresh settlement generation cannot create an endless loop.

The dashboard shows proposed, blocked, accepted and outcome records with reason,
freshness and provider disclosure. Raw task excerpts are transient and excluded
from notebooks, transport logs, training and receipt storage.

## Required implementation acceptance tests

Use real Pi with disposable sessions and a scripted backend. The existing
primitive fixture is evidence of the gap, not a passing implementation of this
contract. The future client implementation must pass:

- Input, stop and revocation during both review and journal persistence; held
  asynchronous input hooks must invalidate the ticket before any model request.
- Deferred custom messages, command handling, queued follow-ups, long tools,
  compaction and native retries; none may be inferred absent from idle alone.
- Duplicate proposals, competing controllers, lost acknowledgements and crashes
  around every journal/turn-claim boundary; no repeated tool or automatic replay.
- Session switches, forks, process restarts, expired tickets and missing/corrupt
  journal state; old authority must not cross identities or erase uncertainty.
- Courtesy check-ins versus actual human decisions, completed work and stops;
  adverse or injected task text cannot grant enrollment or action authority.
- Settled outage with positive safe-continuation evidence versus ambiguous
  dispatch; preserve native retry capabilities and prevent a second owner.
- Visible custom attribution, verified renewed progress, opt-out, content consent
  and unchanged model/provider/tool capabilities.

Only after those tests and interactive rendering checks pass should the optional
DSG adapter advertise this capability or enroll a real session.
