# Safe queued handover

DSG can change the owner of a request only while that request is **still queued
and has never been dispatched to DS4**. This is queued ownership/affinity
balancing, not running-generation migration, cache copying or response replay.

## Automatic core scope

DSG immediately moves a queue-head request when all of these are true:

- it is the conversation's first request through DSG, or it has no affinity;
- the source is busy and the destination is healthy, enabled and completely idle;
- no active, queued or recovery-waiting request has the same session identity;
- no byte has been sent upstream and shutdown/drain is not in progress; and
- durable ownership still matches the source at the instant of commit.

This narrow scope has no previous DSG home cache to abandon. It does not claim
that a direct client has never used a similar prompt or that caches are portable.

An established session gets a conservative **five-minute first-refusal window**
at its warm home. After that measured queue wait, the gateway core may move the
same still-undispatched queue head to a completely idle compatible server. This
fallback is core-owned: a stopped dashboard or unavailable Genie cannot leave an
obviously free server unused forever. It moves at most one request into a free
slot, chooses the oldest eligible head, persists the new home first and applies
the same session-overlap and at-most-once checks below. Cache locality is honestly
recorded as unknown. Set private config
`"automatic_affinity_rebalance_min_wait_ms": false` for strict affinity forever,
or a non-negative whole millisecond value to change the window. Gateway status
reports the effective value and current policy reason.

## Established sessions: exact evidence-bound offer

For an affinity-bound session, DSG may expose a short-lived offer under **Manage
DS4 servers → Safe queued handovers**. The operator may confirm the exact request,
source, destination and evidence digest. After a configured wait threshold, Gate
Genie may instead request one exact offer from his current bounded briefing. DSG
then revalidates every condition; model prose never becomes a routing command.
The destination's cache locality is unknown, so this can trade cold prefill for a
shorter queue. Before the core's conservative escape threshold, Genie can make
that trade only through the exact evidence-bound offer. This is distinct from the
planned learned wait-versus-cache-acquisition policy: no experimental estimate
silently shortens the fixed window, and Genie does not gain general migration
authority.

Offers disappear as soon as their evidence changes. Same-session work anywhere
in the gateway blocks an offer. No active request is eligible.

## Why an idle server was not used

The local status and control surfaces expose bounded `diagnostics` for each live
queue head. They report the exact safety or policy reason that currently prevents
a handover, such as `same_session_active`, `no_idle_destination`,
`durable_home_mismatch`, `automatic_wait_threshold`, or `genie_wait_threshold`.
The record contains worker IDs, a request ID, affinity
class, waiting age and reason codes; it never contains the raw session key or
request body. Gate Genie receives the same sanitized evidence.

Diagnostics explain the current decision; they do not authorize a move and are
not a durable receipt. A status refresh can legitimately produce a different
reason as active work, ownership or destination availability changes. Only an
exact offer accepted by the executor can relocate a request.

DSG also records a separate `routing_tiebreak_shadow` receipt when a new or
unaffined ordinary request enters deterministic routing. It considers only
workers tied on active-plus-queued count. If every tied busy worker has a fresh,
deployed remaining forecast and every queued request has a deployed admission
forecast, it may select the shorter predicted wait within that exact load tie.
Missing evidence from any tied candidate makes the comparator abstain. It never
overrides a freer worker, an established session home or an ineligible worker;
the receipt records whether the reviewed choice was actually applied.

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
