# Exactly what the routing collector stores — schema 1

Implementation: [`dataset.mjs`](../ds4-gateway/dataset.mjs), with observation
points in [`gateway.mjs`](../ds4-gateway/gateway.mjs). This journal supports
operational request, throughput and continuity evidence.
The separate [cache-continuity audit](cache-continuity-audit.md) joins only
allowlisted numerical/session metadata, reports aggregate evidence and preserves
the distinction between measured reuse, high suspicion and an unconfirmed anomaly.

## Common fields on every event

| Field | Meaning |
| --- | --- |
| `schema` | `1`, the record schema version |
| `run_id` | UUID for this gateway process run |
| `event_id` | UUID for this event |
| `time` | Gateway wall-clock ISO timestamp |
| `kind` | `decision`, `dispatch`, `finish`, `queued_cancel`, `queue_timeout`, `unavailable_before_dispatch`, `queue_relocation`, or optional `routing_shadow`, `rejection`, `waiting` |
| `request_id` | Gateway-assigned request UUID, shared across this request's events |
| `node` | Selected registered server ID; null on a pre-admission rejection with no selected server |

## Additional fields by event

| Event | Fields actually recorded |
| --- | --- |
| `decision` | `context_length` (pool guarantee), `affinity`, optional `session`, `traffic_class`, `candidates`, `candidates_truncated`, `client_metadata`, nullable client `call_id` |
| `dispatch` | `queue_ms` |
| `rejection` | `continuity_schema:1`, `call_id`, `session`, typed `code`/`reason`, `dispatch_state:not_dispatched`, `retry_class`, `retry_after_ms`; distinct from a completion/training label |
| `finish` | `outcome`, `queue_ms`, `service_ms`, `total_ms`, `first_body_byte_ms`, `request_bytes`, optional `usage`, `finish_reason`, `requested_thinking`, `generation` (thinking/answer/tool characters, first semantic time) |
| `queued_cancel` | `total_ms` spent admitted before client cancellation |
| `queue_timeout` | `total_ms` spent admitted before queue expiry |
| `unavailable_before_dispatch` | `total_ms` spent admitted before rejecting dispatch to an unavailable assigned server |
| `queue_relocation` | Allowlisted pre-dispatch receipt: source/destination IDs, operator, scheduler or Gate Genie actor, waiting time, `dispatch_state:not_dispatched`, `body_replayed:false`, `deadline_preserved:true`, and explicit unknown cache locality. Analytics joins it to the destination dispatch/finish by gateway run and request ID, but keeps the unobserved no-move result unknown |
| `routing_shadow` | Repeatable, non-label assessment: `shadow_schema`, `reason`, `verdict`, `confidence`, `basis`, `source`, `alternative`, `session_busy`, `waiting_ms`, `saving_ms`, `candidates`, truncation flag |

`client_metadata` contains schema/status/source plus nullable prompt-token
estimate, model-call index, compaction count and requested effort. It is untrusted
client evidence, not an engine measurement. No raw header text is stored. See
the [exact header contract and current collection-only limit](client-metadata.md).
Older decision rows lack this field and must be treated as missing, not zero.

New `finish` events also carry allowlisted `route`, `response_format` (`sse`,
`json`, `other`, `no_response`), nullable `http_status`, `usage_observation`, and
captured `request_stream`/`requested_usage` flags. These flags are observations,
not overrides. Non-streaming OpenAI Chat/Completions JSON usage and finish reasons
are extracted within a **4 MiB metadata capture budget**. The entire response
still forwards unchanged if capture exceeds that bound, cannot parse, or uses an
unsupported format. No response text is stored; whole-response character counts
do not invent a first-token timestamp. Responses/Messages JSON usage and Messages
start/delta usage remain unsupported. Unknown is not zero.

Run the [private data-quality audit](data-quality.md) before tuning. Rejection
receipts are counted separately, not mistaken for orphan or zero-duration jobs.

`affinity` is `new`, `existing`, `none`, or `reassigned`. `session`, when present,
is the SHA-256 digest of the supplied affinity identifier, **not a hash of the
prompt**. It is a linkable private identifier, not a guarantee of anonymization.
`traffic_class` is `genie` when the client declares the observer marker, otherwise
`unclassified`. This is not a trusted actor identity and grants no privileges.

Each `candidates` entry captures the pre-assignment snapshot:

| Field | Meaning |
| --- | --- |
| `node` | Registered server ID |
| `healthy` | Gateway's latest health classification |
| `paused` | Current persisted drain/pause setting |
| `active` | Gateway-dispatched request count on that endpoint, currently 0 or 1 |
| `queued` | Gateway queue length for that endpoint |
| `assigned_sessions` | Count of durable affinity assignments; not hot-cache occupancy |
| `context_length` | Last observed backend context capacity, or null |
| `profile` | SHA-256 fingerprint of server ID, endpoint URL, configured model name and observed context |

This records all registered candidates (up to the explicitly flagged telemetry
bound), including ineligible ones. It does **not** claim all were eligible for
the particular affinity-bound request. It does not measure direct-client load,
actual RAM use, GPU utilization, engine binary identity, KV occupancy or model-file
digest. `profile` does not prove that a server's cache survived a restart.

With the additional opt-in shadow flag, candidate snapshots also contain worker
idle/active/byte ages, session recency on that worker, intervening dispatch count,
prior usage and explicit unknown cache/process identity. Shadow candidates include
historical sample counts and nullable remaining/wait/service/completion estimates.
See [routing shadow](routing-shadow.md) for exact fields, bounds and limitations.
Repeated `routing_shadow` events must not be mistaken for repeated admission
decisions or completion labels; the offline trainer skips them explicitly.

`usage`, when supplied by Chat Completions/Completions SSE or a bounded Responses
terminal event, has `prompt_tokens`,
`completion_tokens` and `cached_tokens`. Missing numerical values become null;
if no usage object was observed, the object is absent. Non-streaming JSON and
Messages start/delta usage are not extracted in this slice. Missing is never
silently treated as zero.

`requested_thinking` contains a parsing status and allowlisted scalar client
controls: `reasoning_effort`, `reasoning.effort`, `output_config.effort`,
`thinking`, `enable_thinking`, `thinking.type`, `thinking.budget_tokens`, as
recognized by the existing observer. It is requested configuration, not measured
reasoning complexity or proof of the server's effective setting. It is collected
after upload, not available to the current placement decision.

Durations use the gateway's monotonic clock. `service_ms` spans dispatch through
upstream finish/failure, **not decode alone**. First body bytes may be a stream
marker or error payload, not a first semantic token. `request_bytes` counts the
forwarded request body, not tokens. `total_ms` includes queue and service time.

An HTTP-complete record can still be output-limited: inspect `finish_reason`
(`stop`, `length`, `tool_calls`, `function_call`, `content_filter`, or null).
Never train a censored cancellation, missing finish, or `length` result as an
unrestricted completion target. A missing terminal event after a process crash
remains incomplete evidence. There is no result label for an unchosen server.

The `outcome` allowlist is `complete`, `client_cancelled`, `upstream_error`,
`upstream_stream_error`, `upstream_aborted`, `upstream_http_error`,
`upstream_engine_error`, `incomplete_sse`, `sse_observation_limited`,
`connection_closed`, and `timeout`. The
engine-error outcome covers a recognized error envelope even inside an HTTP-200
SSE response. Raw backend error strings
and response bodies are not copied into the dataset.

`sse_observation_limited` means an oversized event was discarded and no terminal
could be established within the observer budget. It is unknown, not successful
training data or proof of an engine failure. The live dataset counters report it
separately as `observation_limited`; it is not included in `failed_or_cancelled`.
The schema-1 outcome enum is additive; readers must exclude unfamiliar outcomes
from success training rather than assuming success.

## Separately collected engine telemetry

Existing dashboard files contain allowlisted DS4 timing/cache events: observed
prefill/decode rates, prompt and reused token counts, resident misses, disk
restores and their load times, and observed finish events. This slice **does not
join these to request IDs by guessing from timestamps**. They must not silently
become request-level training features or accusations of a bad route.

## Retired model collection

Model features, embeddings, model predictions and periodic training progress
records are no longer collected. Operational events use `runtime/requests/`.
