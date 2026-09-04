# Evidence collector and Gate Genie (experimental first slice)

## Collector

See the [exact field-by-field schema](collector-schema.md) for what is and is not
recorded, including the distinction between routing evidence and engine logs.

Optional [early client hints](client-metadata.md) are recorded at admission with
client-reported provenance. They do not change inference or yet enter XGB.
The opt-in [Genie notebook](genie-memory.md) persists operational observations,
incident/recovery references and explicitly saved notes, separately from numerical
collection. Full health reports and chat transcripts are not persisted.

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
- Chat Completions/Completions SSE usage and bounded Responses terminal usage are
  copied only when supplied. Non-SSE and Messages start/delta usage remain unknown.
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
write. Retention and optional encoder activation remain operator decisions.
No raw text or credentials are stored. Separately enabled
[local embeddings](embeddings.md) add sensitive derived vectors and availability
metadata. Numerical collection also records bounded semantic progress every 30
seconds while active; it does not guess engine-phase attribution. Keep the dataset
out of Git and public exports.

Completion observation understands each supported API's terminal event rather
than requiring `[DONE]` for every stream. Oversized, unobservable endings are
`sse_observation_limited`, excluded from successful training, and counted separately
from engine failures. This observation limit does not truncate forwarded output.

## Genie

The **Gate Genie health wire** above the capacity panel contains **Genie-written**
observations and, when warranted, a short recommendation. The same model call
produces the detailed assessment and one to four ticker entries; no second
summarizer or extra periodic inference call is added. The prompt asks for serious,
concise advice, not jokes. Enable Genie to receive these headlines; with Genie off,
the wire says so rather than substituting template diagnoses.

Each review returns JSON with `assessment` and `ticker`. Entries contain
`severity` (`good`, `info`, `warning` or `critical`), `text`, nullable `recommendation`, and
`evidence_refs` from the supplied fleet/dataset/worker vocabulary. Length, count
and reference checks reject malformed output; they **do not prove the model's
claims correct**. A rejected ticker leaves its answer readable in the report list
and shows an explicit wire status, never an invented replacement diagnosis.
Text is rendered inertly, not as HTML or executable commands.

Each headline has its own subdued shade and visible severity label: **Good** in
green, **Info** in cool gray, **Warning** in amber, and **Critical** in soft red.
One warning does not recolor unrelated headlines. Existing warning/info reports
remain compatible; unknown or unavailable assessments appear neutral, not as an
all-clear. The Genie chooses severity from supplied evidence, not keyword matching
in the browser. These colors are advice, not independent health proofs or recovery
permissions. Missing data, long thinking or a busy queue alone is not critical.
The wire shows the **evidence snapshot's time**, not the answer completion time.
After ten minutes, a changed inference source, or a change to fleet membership,
health, pause, quarantine, context or gateway-draining state, previous advice is
withheld. Missing gateway status also withholds recommendations. Ordinary queue
movement does not invalidate every review; counts describe that timestamp, not a
live ETA. A failed refresh is labelled while any still-valid review remains.

The briefing explains that historical queue durations are milliseconds, missing
thinking metadata does not alter forwarded reasoning settings, and a resident
cache miss may still restore from disk. The model is instructed not to infer a
stall from long thinking or to claim an action occurred. The wire itself is
advice only. Separately structured requests may ask deterministic executors for
one exact offered recovery, predictor or queued-handover action; prose never
grants a power.

Per-worker `immediately_free` is computed from health, pause/quarantine, gateway
draining, active and queued state. An empty waiting queue does not make a busy
server idle. The briefing distinguishes automatic first/unaffined queued handover
from an exact evidence-bound established-session offer, and states that cache
locality after the latter is unknown. An operator or Genie may request one mature
offer; DSG revalidates it before moving the undispatched stream. It also warns that cache counters may include
diagnostics or unequal observation windows. These explicit facts reduce
misinterpretation; they are not an LLM accuracy guarantee or permission to execute
its recommendations.

Headlines scroll at approximately 42 CSS pixels/second, separated by 8rem gaps.
Hover or keyboard-focus freezes motion and headline updates; **Pause ticker**
holds that state until resumed. The timestamp stays with the frozen evidence.
Reduced-motion preferences show wrapped static text, and the repeated scrolling
copy is hidden from screen readers.

In the web UI, find **Gate Genie** beside **Evidence collection**. **Enable** /
**Turn off** controls the observer. The source dropdown chooses a dedicated-first
policy or explicit DSG-pool use; it does not edit endpoint addresses. In dedicated-
first mode, an explicit connection, HTTP, timeout or malformed-answer failure
causes one attempt through the configured pool fallback. With no `genie.url`, DSG
uses its own pool by default and Gate Genie starts enabled; no extra bot framework
or endpoint is required. An explicitly configured dedicated endpoint automatically
gets a bounded pool fallback unless `genie.fallback` overrides it. There is no URL/model/
credential editor in the UI yet. Set these in
your private config's `genie` / `genie.fallback` objects, then restart only the
dashboard and enable the observer again. Do not change worker URLs or the pool
model just to change the Genie's inference source.

For implemented recovery permissions, see [bounded worker recovery](worker-recovery.md).
Each provider attempt is bounded: both the dedicated provider and pool default to
two hours so long local reasoning is not mistaken for failure. Set an endpoint's
`timeout_ms` from 1,000 through 86,400,000 milliseconds only when its hardware
needs a different budget. The UI separately shows elapsed time and actual remaining
allowance; it does not format a future deadline as an elapsed timestamp. A timeout
counts as an explicit attempt failure and permits the single configured fallback.
A dashboard question preempts an ordinary periodic assessment so chat does not sit
behind replaceable health commentary; it never shortens the provider allowance and
still waits for an evidence-gated action review, which is not safe to interrupt
halfway through its decision.

The separate **Automatic recovery** switch authorizes the runner, not the Genie's
Enable button alone. Editable endpoint controls remain in the [powers plan](genie-powers-plan.md).

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

Restart the dashboard. A configured Genie is **on by default** and his first
review starts within ten seconds. **Turn off** pauses him for the rest of that
dashboard run; private config may set `"enabled": false` for an installation that
should start off. Recovery and predictor mutation remain separately gated;
enabling observation does not grant those powers. Subsequent automatic reviews
start no more often than every five minutes. Manual
questions have a 2,000-character limit and one review can run at a time. A manual
question submitted during a scheduled review is held as the single pending
question, then run next. Its in-memory receipt remains visibly `queued`,
`answering`, `answered`, `failed` or `cancelled`; question text is never included
in status, diagnostics or the training dataset. Turning Genie off cancels a
queued question. A dashboard restart cannot preserve unsent question text.

The experimental observer uses low-effort, maximum-8,192-output-token review
requests with a ten-minute deadline, to keep diagnostics bounded. These are its
own requests, **not production server defaults or limits on user requests**. A
budget-exhausted answer is reported incomplete, never presented as a finished
assessment. Existing server context, output settings and caches are unchanged.

The source selector chooses dedicated-first or normal DSG-pool-only operation.
Pool requests are deliberately unpinned: a Genie review contains its complete
bounded live briefing, so any available DS4 server may serve it. It competes for
one normal inference slot; first/unaffined queued-handover rules can move that
still-undispatched call to a newly free server. Pool calls receive no private
Genie notebook history. If the dedicated attempt fails explicitly, DSG makes one
pool attempt and marks the report `pool_fallback`; it never combines partial model
answers or processes actions from a failed attempt. If both fail, no report or
action is accepted. Off cancels the local review connection; that alone does not
prove backend execution stopped.

This is a question + fresh-briefing interface, optionally augmented by bounded
notebook history, not a persistent multi-turn agent conversation. Twelve recent assessments live in memory and are
not included in downloadable diagnostics or training records. The model has no
shell or control credentials. Its optional structured `recovery_requests`,
`predictor_requests` and `relocation_requests` are validated against exact current
offers and rechecked by their deterministic runners;
prose is rendered as text, never executed. Durable executor receipts are separate
from in-memory assessments and are included in sanitized operational status.
The dashboard's same-origin/CSRF checks protect its enable/source/ask and notebook
controls. Memory can collect while Genie inference is off; switching memory off
retains its records. Notes are excluded from diagnostic exports and training data.

See the sanitized [worker-reachability incident](incidents/2026-09-03-worker-reachability.md)
for the distinction between tunnel self-healing, busy-server probe evidence and
an evidence-authorized DS4 service recovery.

Click a report heading (or focus it and press Enter/Space) to read the assessment.
The five-second status refresh preserves open reports and text selection. The
panel normally shows the latest three reports; an older open or keyboard-focused
report stays visible while you read, even as newer reports arrive. This is only
page-local reading state, not durable history across a page/dashboard restart.

The optional [predictor lifecycle](predictor-lifecycle.md) is implemented: GG can
request offered training or evidence-backed rollback, while independent validators
decide promotion. Turning Genie off does not disable predictor automation or the
separately authorized recovery runner. [Embedding collection](embeddings.md) is
also implemented and opt-in. See the [roadmap](roadmap.md) for exact cache-health
attribution, persistent conversation/history and further operational powers.
