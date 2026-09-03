# Queued-work routing shadow

This is an opt-in evidence collector and **unvalidated historical comparison**.
The shadow itself cannot move a request, change affinity, replay output, restart
a server or modify model settings. DSG separately implements a narrow
[safe queued-handover contract](queued-handover.md); shadow verdicts neither
trigger nor authorize it.

## Enable and observe

In your private gateway configuration, set both:

```json
{
  "dataset_enabled": true,
  "routing_shadow_enabled": true
}
```

Back up the private configuration first. Activation needs a controlled gateway
restart; editing the file does not update a running process. Respect active and
queued work. Remove/set the shadow flag to false and restart to disable it;
existing private evidence is preserved. Neither flag changes model context,
output limits, hot slots, concurrent generation or thinking settings.

The authenticated `/gateway/status` response includes `routing_shadow` counters
and the latest summary. Numerical records go to the existing private routing
dataset. No dedicated shadow UI panel ships in this slice. The normal dashboard
capacity percentage still describes occupied **eligible gateway request slots**,
not GPU usage or relative compute speed. One busy, one idle and one unavailable
server is 50% of eligible slots occupied, but only one of three registered servers
serving. An idle slot plus a pinned queue is real under the current policy.

## New decision-time evidence

With shadow collection enabled, each admission's candidate snapshot also records:

| Field | Meaning |
| --- | --- |
| `worker_idle_ms` | Time since an observed request finished on this idle gateway worker; null before the first observed finish or while active |
| `active_elapsed_ms` | Time since the active request was dispatched |
| `active_request_id` | Gateway UUID for joining that active request to its later outcome, within this run; never a future outcome feature |
| `upstream_byte_age_ms` | Time since any upstream body bytes, if seen; **not proof of semantic progress** |
| `session_last_used_ms` | Time since this session last dispatched on this worker |
| `session_last_finished_ms` | Time since its last observed successful, uncensored finish on this worker |
| `intervening_requests` | Other dispatches since that last use; a cache-pressure clue, not a distinct-session count or eviction proof |
| `prior_prompt_tokens`, `prior_cached_tokens` | Last successful observed usage for this session on this worker; not the current request's usage |
| `cache_residence` | Always `unknown` in this slice; no claim of hot RAM or disk presence |
| `backend_epoch` | Null in routing rows: the dashboard observes systemd process epochs, but no verified request-to-engine join exists yet |
| `observation_epoch` | Local reset counter, **not** backend identity |

Clocks are monotonic within the gateway run. A restart starts with unknown history,
not invented zeros. Observed health loss, quarantine, removal or context changes
discard affected in-memory history. The dashboard's journal observer can now
detect systemd process-epoch changes, but that read-only evidence is not yet
joined into gateway admission rows. An unobserved fast backend restart can
therefore still be absent from a routing row; this is a reason the estimator has
no operational authority.

The new fields are retained for later feature engineering. The existing offline
XGB feature schema is not silently replaced and does not yet consume these fields.

## Assessments and prediction limits

An additional `routing_shadow` event is recorded at admission and when a worker
finishes, for pending head-of-line requests. Only queued, undispatched requests are
considered. Candidate snapshots describe the state at assessment, before any
hypothetical action. A pending request's actual routing is unchanged.

The baseline groups recent completed service times by worker, API route and
power-of-two prompt-size bucket. The bucket for a waiting request comes from its
session's previous completed request, not unseen queued text. At least five
matching observations from the last hour are required. Samples must have a
successful, uncensored terminal result and numerical prompt usage. Genie-marked
traffic, errors, missing results and output-limited runs are excluded.

For active work, remaining time is the median of `(duration - elapsed)` among
matching completed samples whose duration exceeded the current elapsed time.
There must be at least five such survivors. Beyond the observed duration support,
the result is **unknown**, not zero or "overdue." This is not a calibrated survival
model: excluding censored observations and a non-random workload can bias it.

For a candidate: predicted completion time = remaining active time + service
estimates for jobs ahead + service estimate for this request. Missing any component
makes the total unknown. Service includes cache restoration, prefill and generation;
those costs are not yet separated. Cache states and thinking modes are mixed in
the small historical baseline. Compaction, a changed request, a new thinking mode
or a cold alternative can invalidate the estimate. Every result therefore carries
`confidence: unvalidated` and `basis: prior_session_prompt_bucket_mixed_cache`.

Only genuinely idle alternatives are compared with the current home. If the same
session has another queued or active request anywhere, the verdict is
`handover_blocked`; a future implementation must establish per-session ownership.
Other verdicts are `insufficient_evidence`, `no_idle_alternative`, `would_stay` and
`would_move`. Even a `would_move` result is **not a recommendation to an autonomous
actor** and does not override any admission, health or ownership rule.

"Idle" here means no active or queued **gateway** request. Direct-client traffic
or a backend still computing after a broken connection is not ruled out by a
successful model-list probe. Verified engine progress/idle state remains future work.

The alternative's result is counterfactual: it is never written as an observed
completion label. The offline trainer explicitly ignores repeated shadow events.
Do not use them as labels or duplicate the request into multiple training rows.

## Bounds and privacy

- Default off; needs the existing private collector enabled too.
- No extra model calls, embeddings, SSH probes or request-body capture.
- Histories: at most 128 tracked workers, 4,096 worker/session pairs, and 128
  samples per worker; only the last hour qualifies for estimates.
- Each free event evaluates at most 32 worker queue heads. Each assessment captures
  at most 128 candidates; truncated candidate sets are flagged in the record.
- Existing dataset queue/storage limits apply; dropped records do not block
  inference. No automatic deletion. Observation exceptions are counted and isolated.
- Status contains registered IDs and aggregate counters, not conversation text.
  Dataset session hashes remain linkable private metadata, not anonymization.

Tests cover monotonic recency/pressure, abstention, stale/missing/censored data,
unavailable/paused alternatives, unresolved session work, bounded memory, privacy,
unchanged request bytes/affinity, reassessment and exclusion from XGB labels.

## Next increments

1. Surface pinned queues, unavailable capacity, evidence age and comparisons in UI.
2. Add verified process epochs and request-correlated cache/progress evidence.
3. Collect bounded local embeddings and current-request features with explicit
   availability timestamps; do not block request forwarding or spool raw text.
4. Refit/evaluate the XGB estimator, including a remaining-service-time target and
   fixed fallback. Compare metadata-only versus embedding-assisted models.
5. Validate counterfactual predictions with small controlled calibration trials;
   then decide whether the implemented exact established-session handover may be
   automated behind an uncertainty margin and hysteresis. Until then it remains
   operator-confirmed; only first/unaffined work moves automatically.

Predicting **when a busy worker becomes free** is the first objective. Predicting
how long an already idle worker will stay idle requires an arrival-demand model;
it is separate and not necessary for the first overflow decision.
