# Consecutive conversation turns

DSG defaults to five model requests per conversation allocation on each server. This gives a conversation consecutive access while its cache may be warm, then yields to another waiting conversation. It changes scheduling only; it does not batch questions into one request, change model parameters, or guarantee a cache hit.

Configuration in `config.local.json`:

```json
{
  "conversation_turns": 5,
  "conversation_turn_idle_ms": 2000
}
```

`conversation_turns` is a positive integer. Set it to `1` for FIFO within each explicit priority class, without a continuation grace period. The idle setting is a nonnegative integer in milliseconds (up to the platform timer limit, 2147483647); `0` permits priority only for continuations already queued. In **Settings → Conversation scheduling**, edit **Consecutive conversation turns** and click **Apply**. The count applies live at the next scheduling decision and is saved in the gateway state, taking precedence over the configuration value across restarts. The current value and its source are shown beside the control. Active responses finish normally; their already-used turns count toward the new allowance. Lowering an exhausted allowance ends its idle grace and yields to another waiting conversation without replaying or interrupting a response. Conversation affinity, model servers and caches are preserved. The idle-gap setting remains configuration-only and requires a coordinated gateway core restart to change. Each saved count has a timestamped state backup; stale edits are rejected so one browser cannot silently overwrite another. These effective values are exposed in `/gateway/status`, and each worker's `turn_allocation` reports turns used, remaining allowance and remaining idle grace.

## Scheduling rules

- A dispatched model request consumes one turn. Tool execution outside DSG consumes no turn; the model request following the tool result consumes the next turn.
- A higher [explicit queue priority](queue-priority.md) takes precedence over a lower-priority conversation reservation. Running requests finish, and later requests cannot pass earlier requests in the same conversation.
- Within a priority class, while below N, the oldest queued request from the allocated conversation can precede other conversations. Within a conversation, request order stays FIFO.
- After each successful response, DSG allows up to the configured idle gap for a continuation to arrive. The gap starts at response completion, not when a competitor arrives. Once it expires, the oldest waiting request proceeds.
- At N, the oldest eligible request from another conversation in the highest waiting priority class proceeds, even if the current conversation has pipelined more requests. When there is no competitor, the conversation may start another allocation and continue beyond N.
- A failed or cancelled active request releases its unused allowance. Queue cancellation and deadlines remain in effect. Missing conversation IDs use FIFO within their priority class and never acquire an allocation.
- Allocations are local to each worker and are not persisted across restart. Existing routing, worker pauses, health checks, conversation ownership, no-replay protections and one active request per worker remain in effect. A turn count is not a maximum generation duration.

## Hourglass integration contract

Send a stable `x-session-affinity` header on every model request belonging to the same benchmark conversation, including tool continuations and follow-up prompts. Use a distinct ID for each independent question/conversation and concurrent attempt; do not reuse one ID for the whole benchmark or worker route. DSG also recognizes its existing `x-ds4-conversation-id`, `x-session-id`, and `session_id` headers, in that priority order after `x-session-affinity`.

Example request headers:

```text
x-dsg-model: spark1
x-session-affinity: hourglass-<unique-attempt-conversation-id>
```

`x-dsg-model` selects the configured worker route. It does not identify the conversation. Do not use a request ID that changes at every tool turn as the affinity value.

In Pi 0.85.1, the OpenAI completion adapter defaults `sendSessionAffinityHeaders` to false. The Hourglass owner can explicitly enable `compat.sendSessionAffinityHeaders` for DSG models so Pi sends its session ID, or attach the header at the existing DSG transport boundary using one stable per-conversation ID. Verify two successive model calls share the header and independent conversations differ. Configure this in the client; DSG cannot infer conversation identity from a worker route.

Use `http://127.0.0.1:30000/testing/v1` while Testing is on. The same scheduler applies to testing and normal inference. Compare N=1 and N=5 using concurrent conversations, recording dispatch order, queue wait and completed work. Cache and throughput improvements require measurements from the actual backend.

Clients must permit long queue waits independently of the turn allowance. See
[Pi client timeouts](pi-client-timeouts.md) for the existing timeout setting and
the distinction between queue heartbeats and absolute request deadlines.
