# Evidence collector and Gate Genie (experimental first slice)

## Collector

See the [exact field-by-field schema](collector-schema.md) for what is and is not
recorded, including the distinction between routing evidence and engine logs.

Set `"dataset_enabled": true` in your private gateway config, then restart the
gateway when safe. Model servers and their settings do not need to change.
The default is off. Evidence is written under `training/` beside the affinity
state file, in daily mode-0600 JSONL files inside a mode-0700 directory.

Records have a schema version, gateway-run ID, event ID and request ID. Join
`decision`, `dispatch` and `finish` by run/request ID. Other terminal records
identify queued cancellation, expiry or unavailability before dispatch.
An incomplete sequence after a crash is incomplete evidence, not a success.
Events are asynchronously batched and flushed; an abrupt crash can lose pending
events or leave a partial trailing line. Readers must reject incomplete lines.

- Decision features are captured before assignment and queue insertion.
- `profile` fingerprints endpoint/model/advertised context, **not** an attestation
  of engine binary, quantization or cache configuration; those fields need future
  explicit instrumentation. Do not treat unchanged profile as proof of cache survival.
- Queue/service/total durations use a monotonic clock. `first_body_byte_ms` is
  explicitly first upstream body bytes, **not** guaranteed first semantic token.
- SSE token usage is copied only when supplied. Non-SSE/missing usage is unknown.
  SSE finish reasons are retained when supplied: an HTTP-complete response with
  `finish_reason: length` is output-limited, not an uncensored completion target.
  Missing finish reasons remain unknown, not assumed `stop`.
  Requested thinking is observed after upload; it is not currently a decision-time
  feature. Input byte counts are not token counts.
- The observer traffic marker is client-declared, not an authenticated identity;
  it grants no authority. Exclude Genie reviews from normal-workload benchmarks.
- Separate engine timing logs remain useful, but this slice does not guess a
  request-to-engine join from nearby timestamps. No cache bug attribution yet.

The queue is bounded to 512 events, 64 KiB per event, 128 candidate snapshots per
decision (truncation explicitly flagged). These bound telemetry only, never fleet
size, context or inference. At 1 GiB stored, collection pauses and reports an error;
it **does not delete evidence** or block inference. No automatic expiry yet.
The UI shows current-run saved/pending/dropped counts, total stored bytes and last
write. Retention and encoder choices remain operator decisions. No raw text,
embeddings or credentials are stored. Keep the dataset out of Git and public exports.

## Genie

In the web UI, find **Gate Genie** beside **Evidence collection**. **Enable** /
**Turn off** controls the observer. The **Dedicated server / DSG pool fallback**
dropdown chooses between existing configured endpoints; it does not edit their
addresses. There is no URL/model/credential editor in the UI yet. Set these in
your private config's `genie` / `genie.fallback` objects, then restart only the
dashboard and enable the observer again. Do not change worker URLs or the pool
model just to change the Genie's inference source.

For planned recovery permissions and editable endpoint controls, see the
[Genie powers plan](genie-powers-plan.md). The current Enable button grants no
restart or routing authority.

Example **private** config addition (illustrative ports/SSH alias):

```json
{
  "genie": {
    "url": "http://127.0.0.1:38011/v1",
    "model": "deepseek-v4-flash",
    "ssh": "conductor-host",
    "remote_port": 8001,
    "fallback": {
      "url": "http://127.0.0.1:30000/v1",
      "model": "deepseek-v4-flash",
      "api_key": "YOUR_GATEWAY_KEY"
    }
  }
}
```

Omit `ssh`/`remote_port` for an already-local endpoint. The dedicated server's API
key is optional; omit it for unauthenticated DS4 behind authenticated SSH. SSH uses
your existing verified host key and login, loopback-only forwarding, and reconnects
without changing the remote server. Keep the chosen local port free.

Restart the dashboard, then **Enable** Gate Genie in its panel. It is off after
every dashboard restart. The first enabled review starts within ten seconds;
subsequent automatic reviews start no more often than every five minutes. Manual
questions have a 2,000-character limit and one review can run at a time.

The experimental observer uses low-effort, maximum-8,192-output-token review
requests with a ten-minute deadline, to keep diagnostics bounded. These are its
own requests, **not production server defaults or limits on user requests**. A
budget-exhausted answer is reported incomplete, never presented as a finished
assessment. Existing server context, output settings and caches are unchanged.

The source selector chooses the dedicated endpoint or normal DSG pool. Pool mode
uses regular authenticated routing/affinity and competes for a normal slot. It
does not move the ordinary gateway or register the dedicated observer server in
the pool. Failure does not automatically replay on another machine. Off cancels
the local review connection; that alone does not prove backend execution stopped.

This is a stateless question + fresh-briefing interface, not yet a persistent
multi-turn agent conversation. Twelve recent assessments live in memory and are
not included in downloadable diagnostics or training records. The model has no
tools or control credentials, and its prose is rendered as text, never executed.
The dashboard's same-origin/CSRF checks protect its enable/source/ask controls.

See the [roadmap](roadmap.md) for embeddings, XGBoost, cache-health attribution,
frozen-agent packaging and independently tested operational powers.
