# Exactly what the routing collector stores — schema 1

Implementation: [`dataset.mjs`](../ds4-gateway/dataset.mjs), with observation
points in [`gateway.mjs`](../ds4-gateway/gateway.mjs). This numerical evidence feeds
the optional [predictor lifecycle](predictor-lifecycle.md) and the preserved
[v1 offline experiment](../predictor/README.md). Collection does not by itself
enable prediction-based placement or constitute a cache-hit auditor.

## Common fields on every event

| Field | Meaning |
| --- | --- |
| `schema` | `1`, the record schema version |
| `run_id` | UUID for this gateway process run |
| `event_id` | UUID for this event |
| `time` | Gateway wall-clock ISO timestamp |
| `kind` | `decision`, `dispatch`, `finish`, `queued_cancel`, `queue_timeout`, `unavailable_before_dispatch`, `queue_relocation`, `progress`, or optional `routing_shadow`, `request_features`, `embedding`, `model_prediction` |
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
| `queue_relocation` | Allowlisted pre-dispatch receipt: source/destination IDs, operator or scheduler actor, waiting time, `dispatch_state:not_dispatched`, `body_replayed:false`, `deadline_preserved:true`, and explicit unknown cache locality |
| `routing_shadow` | Repeatable, non-label assessment: `shadow_schema`, `reason`, `verdict`, `confidence`, `basis`, `source`, `alternative`, `session_busy`, `waiting_ms`, `saving_ms`, `candidates`, truncation flag |
| `progress` | `progress_schema:1`, `prediction_point:while_active`, `active_elapsed_ms`, `phase`, `semantic_characters`, `semantic_age_ms`, thinking/answer/tool character counts, `requested_thinking` |
| `request_features` | `feature_schema:2`, `prediction_point:after_upload`, extraction/status, `available_at`, request bytes, bounded role/message/text/image/tool counts, output controls and history-scan flag |
| `embedding` | `embedding_schema:1`, status/extraction; ready rows add model/revision/dimensions, per-scope vectors/token metadata, queued/available times and encoding duration |
| `model_prediction` | `predictor_schema:2`, `model_id`, `model_kind`, `prediction_stage`, `experimental`, `seconds`, `baseline_seconds`, `elapsed_s`, `available_at` |

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

## Optional derived embeddings and progress

No raw prompts, answers, hidden reasoning text, image data, tool arguments,
credentials, or model/cache files are stored by this collector. Optional
[local embedding collection](embeddings.md) stores derived vectors for bounded
latest-user and preceding-visible-conversation slices. The linked contract names
the exact encoder, revision, dimensions, pooling, tokenizer bounds, exclusions,
failure behavior and sensitive-data handling. No prompt-similarity cache identity
or cache-hit proof is inferred from those vectors.

Progress records start at dispatch and repeat every 30 seconds until termination.
Semantic character/age measurements come from recognized SSE text/reasoning/tool
deltas, not heartbeats; they do not contain source text or prove prefill phase.
Unknown/unsupported progress remains unknown. New stream kinds must not create
duplicate training examples or false analytics gaps.

Use only features available by a predictor's declared prediction time. Embedding
ready times occur after initial placement and sometimes after a short request
finishes. No future-answer embedding or hindsight routing prediction is permitted.
Historical numerical records cannot be backfilled because raw text was not kept.
Compare metadata-only and embedding-assisted predictors before adopting either.

For storage bounds, permissions and UI counters, see [observer setup](observer.md).
For the next embedding collection slice and its feature-availability boundaries,
see the [delivery decisions in the roadmap](roadmap.md#immediate-next-delivery-decisions--2026-09-02).
