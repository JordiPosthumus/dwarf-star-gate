# Specialize in DS4; do not modify the engine

DSG is a companion specifically for [antirez's DS4](https://github.com/antirez/ds4),
not a generic inference gateway with renamed labels. Know its request protocol,
cache semantics, usage fields, timing logs and failure modes well. **Adapt DSG
to supported DS4 interfaces; do not require a private DS4 patch or rebuild.**
Different existing engine versions may expose different evidence. Missing
telemetry is a capability gap, not permission to change the server or fabricate it.

## Current evidence sources

| Source | Useful evidence | Limit |
| --- | --- | --- |
| Gateway request lifecycle | Queue, dispatch, first semantic output, generation progress, completion/error, worker and request ID | Exact for traffic through this gateway; not direct clients |
| DS4 response usage | Prompt/output counts and reported prefix-cache reuse when present | Cache reuse alone does not identify RAM versus disk; absent fields stay unknown |
| Existing DS4 timing logs | Prefill/decode rates, prompt boundaries, resident misses, disk-load duration | Parsed allowlist only; missing logs and interleaving prevent exact request attribution |
| Existing process/service evidence | Enrolled service identity and failure/recovery evidence | Not interchangeable with an endpoint or model-name fingerprint |

The implementation lives in [gateway.mjs](../ds4-gateway/gateway.mjs),
[telemetry.mjs](../ds4-gateway/telemetry.mjs),
[attribution.mjs](../ds4-gateway/attribution.mjs),
[cache-cost.mjs](../ds4-gateway/cache-cost.mjs) and the optional recovery adapters.
The engine owns inference and KV state. The gateway owns routing evidence and
its own request IDs. DSG already sends `x-request-id`; sending that header does
not prove the engine records or echoes it in timing events.

## Measurement improvements, without a server edit

1. Inventory the already-deployed DS4 version and exposed protocol/log fields
   read-only. Record the source of each capability; do not infer it from the model
   name or from another machine's build. Do not probe by generating work silently.
2. Maintain tested parsers for supported existing log formats, bounded buffers,
   reconnect/rotation handling and numeric allowlists. Never enable raw prompt
   dumping or retain raw diagnostic logs in the public repository.
3. Keep directly associated API measurements separate from heuristic engine-log
   associations. Preserve request/time/worker provenance and missing/error status.
   A candidate time-window association is a hypothesis, not an exact training label.
4. Backend process epochs are now extracted for systemd journal sources from the
   stock invocation ID, with boot ID plus PID as an explicitly weaker fallback.
   DSG exports only a one-way, worker-bound digest. A reconnect with the same
   service invocation is not a restart; a changed digest invalidates in-flight
   telemetry spans and component samples without touching the engine. Local file
   sources and missing metadata remain unknown rather than receiving a guessed
   epoch. Request-to-engine correlation remains the next step. Fail closed on
   ambiguous spans, competing direct traffic, dropped events or clock alignment.
5. If stock interfaces cannot establish an exact cache-to-request link, retain
   component-level estimates and abstention. Do not introduce a mandatory custom
   engine, fake cache-hit percentage or guessed zero acquisition cost to fill a UI.

These are the next extraction/attribution steps, not claims that every reader
already has full process-epoch correlation. See [cache-cost limits](cache-cost.md).
Future upstream capabilities can be supported when available and verified;
installing a new server version remains a separate operator-controlled decision.

## Upstream contributions

Keep an eye out for small, mutually beneficial improvements to
[antirez's DS4](https://github.com/antirez/ds4), especially observability/protocol
information useful to other clients too. Record the limitation, alternatives,
minimal reproducer and tests. Before proposing a PR, inspect current upstream
source and issue/PR history for existing solutions; establish backward
compatibility and low overhead. “Useful to DSG” alone is not proof of broad value.

Bring high-confidence candidates to the operator first. Do not submit a PR,
patch/rebuild a server or install an engine automatically. DSG must remain useful
with stock interfaces; any proposed upstream feature is an optional capability,
not a private-fork requirement. Preserve attribution/licences and keep private
infrastructure/workload details out of issues, reproductions and benchmarks.

## Calibration must preserve production caches

The planned manual/optional hourly development runner must have a proven
non-displacing execution path before it sends any synthetic work. **Skip when
warm-cache preservation cannot be established.** No active/queued gateway work
is necessary but insufficient: idle servers can still hold valuable hot sessions,
and direct clients can be invisible to DSG. A maximum number of hot slots is not
a measurement of which slots are resident or safe to use.

Use a separately provisioned calibration server or another verified stock-DS4
mechanism only when it actually preserves production state and resources. Do
not assume session IDs, cancellation or a short prompt make eviction impossible.
The future UI must expose skip reason, execution budget and whether the results
are synthetic calibration or production observations. Ordinary workload collection
and CPU retraining continue even when every calibration opportunity is skipped.

## Genie boundary

GG may interpret DS4-specific evidence and use explicitly enrolled, tested DSG
controls. It must not edit DS4, inject flags, alter model/cache settings or invent
shell commands. Existing opt-in recovery remains a separate capability: restart
only the enrolled service, with its existing settings and independent checks.
Restart loses hot RAM state and is not a calibration technique. Parser failure,
missing metrics or a model losing to baseline do not authorize recovery.
