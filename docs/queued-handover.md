# Safe queued handover

DSG can change the owner of a request only while that request is **still queued
and has never been dispatched to DS4**. This is queued ownership/affinity
balancing, not running-generation migration, cache copying or response replay.

## Automatic, cache-neutral scope

DSG automatically moves a queue-head request when all of these are true:

- it is the conversation's first request through DSG, or it has no affinity;
- the source is busy and the destination is healthy, enabled and completely idle;
- no active, queued or recovery-waiting request has the same session identity;
- no byte has been sent upstream and shutdown/drain is not in progress; and
- durable ownership still matches the source at the instant of commit.

This narrow scope has no previous DSG home cache to abandon. It does not claim
that a direct client has never used a similar prompt or that caches are portable.

## Established sessions: exact evidence-bound offer

For an affinity-bound session, DSG may expose a short-lived offer under **Manage
DS4 servers → Safe queued handovers**. The operator may confirm the exact request,
source, destination and evidence digest. After a configured wait threshold, Gate
Genie may instead request one exact offer from his current bounded briefing. DSG
then revalidates every condition; model prose never becomes a routing command.
The destination's cache locality is unknown, so this can trade cold prefill for a
shorter queue. DSG does not make that trade automatically until the wait-versus-
cache-acquisition estimator has passed its independent promotion gates. Genie
does not bypass that broader boundary: his present action is one offered,
still-undispatched move, not general migration authority.

Offers disappear as soon as their evidence changes. Same-session work anywhere
in the gateway blocks an offer. No active request is eligible.

## Commit and failure contract

The handover persists the new session owner before changing in-memory queues. If
that durable write fails, the original request, client and source queue remain
untouched. After a successful commit DSG moves the same request object:

- original client socket and unread upload stream;
- original admission timestamp and queue deadline;
- identical request bytes, without replay or buffering to disk; and
- one response channel, dispatched at most once by this mechanism.

The private receipt records `dispatch_state:not_dispatched`,
`body_replayed:false`, `deadline_preserved:true` and `cache_locality:unknown`.
The numerical collector may retain that allowlisted receipt, never the body or
raw affinity value.

This contract does not recover a request after dispatch, resume a broken SSE
stream, transfer a KV snapshot, or survive a gateway-process restart. Those are
separate problems with different proof requirements.
