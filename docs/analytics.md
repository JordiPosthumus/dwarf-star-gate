# Analytics and the latency-model plan

The local dashboard has a focused **Analytics** view, separate from live fleet,
Gate Genie and request-history controls. It evaluates predictions already saved
by the optional [routing shadow](routing-shadow.md) and
[predictor lifecycle](predictor-lifecycle.md). The reader does not fit models or
change placement. Separate controls in the panel manage the bounded trainer,
validation policy and optional new-session placement. With collection alone,
actual durations can be available while predictions remain missing.

## Reading the panel

- **Queue wait ≥ 1s:** admission to upstream dispatch. Waits below one second
  are counted separately so immediate dispatches do not dominate the score.
- **Server time:** dispatch to a successful complete response, including upload,
  cache work, prefill, reasoning, answer and transport. It is not decode time or
  pure GPU time. It excludes gateway queueing.
- Each dot pairs one saved prediction with the chosen server's measured result.
  Both axes use the same linear scale and units. Above the diagonal means an
  underestimate. Hover for exact values; filter by server rather than assuming
  pooled performance applies equally to every device.
- Coverage is matched forecasts divided by eligible measured requests in the
  selected window/filter. Mean absolute error uses only those matched pairs.
  Neither is a calibration certificate, and neither measures outcomes on servers
  that were not chosen. Tiny or selectively predictable samples can look good.

The baseline source is explicitly **unvalidated historical baseline, not XGB**.
It uses prior-session prompt buckets with mixed cache conditions. Its initial
admission forecast is frozen; later worker-free re-evaluations do not replace a
bad forecast or count as extra independent examples. The saved elapsed admission
time is added to predicted remaining wait before comparing with total queue wait.
Null is unknown, not zero. No hindsight estimates are generated for older requests.

XGB choices are separate: admission, after upload, after embeddings and remaining
at the first recorded progress point at/after 30 seconds. Select one model version;
versions/stages are not pooled. Experimental status is explicit. Remaining actual
time subtracts elapsed from total server time; later updates never replace the
frozen chart forecast. The lifecycle table separately scores all bounded remaining
updates with one aggregate weight per request. Coverage includes successful
requests with no forecast admitted after the version/stage's first saved forecast,
plus its matched requests. Remaining coverage requires at least 30 seconds of
successful server time. Unsupported/missing forecasts count as missing, not zero
or successes. This is a bounded observed deployment window, not all gateway history.

Joining requires the same gateway run, request and actual worker. Duplicate event
IDs are ignored; conflicting lifecycle events are rejected. A queue wait is known
at dispatch even if the response later fails. Cancelled/timed-out/otherwise rejected
queues have no exact dispatch wait and are counted separately, not assigned zero.
Failed, output-limited, incomplete and unfinished responses are not successful
service-duration labels. Genie traffic is excluded. This success-only service
score does **not** measure reliability or the cost of failures.

Applied pre-dispatch handovers have a separate bounded outcome join. It reports
the actual source/destination, wait already paid before the move, additional wait
at the destination, successful service duration and reported prompt-cache reuse.
Because the selected worker changed, these requests are not silently folded into
the original decision-node predictor score or XGB labels. The no-move outcome was
not observed and remains unknown; the dashboard never calls the destination result
"time saved" without a separately justified counterfactual.

## Scope and privacy

This is a bounded recent window, not a warehouse or the offline training dataset:
up to 500 dispatched requests, 4,096 lifecycle records and 16,384 deduplication
IDs in memory. A read-only reader tails the latest two daily numerical evidence
files, starts at most 8 MiB back per file, and processes at most 256 KiB per file
per poll. Large histories may have missing joins. The UI discloses skipped history,
unjoined/rejected events and malformed records. It preserves partial lines and
handles observed file rotation/truncation by rebuilding the window. Queued and
unfinished records can include old interrupted work, not just current jobs.

The reader does not create, delete or edit evidence, follow file symlinks, call
models, retrain XGB, restart servers or change routing. Its same-origin read-only
`/api/analytics` response contains only selected worker/timing/coverage fields—no
prompts, vectors, session/request identifiers, endpoints or filesystem paths.
Analytics is separate from the existing diagnostic download. These measurements
are still private deployment data: do not commit captures of the live panel.
Use explicitly synthetic examples for public screenshots.

Analytics-only code needs a dashboard-only restart. Enabling new embedding or
progress collection also needs a gateway restart in an approved window; model
servers do not need restarting. The dashboard freezes its UI bundle at startup; preserve
Genie assessments privately before restarting because they remain in memory.

The panel now also exposes [local encoder status](embeddings.md) and a
[measured cache-cost calculator](cache-cost.md). These are separate from the
historical forecast chart: fitted XGB and embeddings do not change baseline dots.
New XGB dots appear only after the separately configured predictor is running.
The same collapsed cache section reports process-epoch coverage and recent
request/engine correlation outcomes. `Corroborated` remains a bounded candidate,
not protocol identity or proof that a particular KV tier supplied the request;
abstentions and their leading reasons remain visible rather than becoming zeros.

## Which predictions are actually needed?

The objective is **shortest expected completion time among safe feasible routes**,
not maximum decode speed or minimum queue wait in isolation.

| Quantity | Purpose | Initial implementation / next step |
| --- | --- | --- |
| Total server time for a new request | Cost after dispatch on each candidate | Versioned V2/V3 admission and updated XGB contracts, fixed validation and optional new-session placement |
| Remaining busy time of an active request | When a server can accept its next job | Conditional-history baseline plus optional versioned elapsed/phase-conditioned XGB; censored outcomes excluded and unsupported elapsed ranges abstain |
| Cache acquisition + suffix prefill time | Cost of hot reuse, local restore or cold execution | Measured disk/prefill component baseline implemented; exact request/epoch attribution, cache existence and unmeasured costs remain next |
| Generation duration, including reasoning | Work after prefill until the response ends | Initially part of total server time; separate only with trustworthy phase/output labels |
| Queue wait | Remaining active work plus requests ahead | Derive from the quantities above and actual admission rules; no separate idle-demand model needed |

Do not build five unrelated XGBs merely because there are five quantities. Start
with one well-evaluated total-service predictor and a residual-busy estimator.
Decompose service time only when attribution makes the parts identifiable.
Predicting how long an *idle* server remains unused is demand forecasting; it is
not a prerequisite for routing an already waiting request.

For long thinking, `average duration − elapsed` is not a valid residual estimate.
Condition on the request still running, its phase, elapsed time and fresh progress.
Cancelled/interrupted jobs are censored observations, not short successful jobs.
Beyond observed support, abstain rather than return a confident zero. Later
intervals must have measured coverage; a point estimate is not a confidence band.

Use device identity **and** shared hardware/configuration features, prompt length,
reasoning controls, cache evidence, load, process epoch and feature-availability
times. New devices start uncertain and can share hardware-class evidence without
being declared equivalent to a particular existing machine. Freeze model/schema
versions with predictions so different candidates are not pooled unknowingly.

The current gateway places requests before reading their bodies. Embeddings and
current-request text features collected later cannot be used retrospectively at
that decision point. [Local bounded embedding collection](embeddings.md) is now
an optional separate data slice, with feature-availability times. No raw text was
retained to backfill old rows. Correlated 30-second progress records prepare the
remaining-busy-time dataset; they do not activate a remaining-time learned model.

Why can the service chart look poor? The baseline is a per-worker median in a
broad **previous** prompt-size bucket. It does not distinguish current workload,
thinking duration or hot/disk/cold cache state. Predictions can cluster together
while actual durations vary widely. Queue forecasts additionally know elapsed
active time and the requests ahead, but inherit errors in those jobs' durations.
Compare coverage and error, not just the apparent shape of the plotted subset;
missing forecasts and failed/unfinished service jobs are not plotted as successes.

Before promoting XGB: use forward-time validation with unavailable labels purged,
select tree count within training folds, retain a later holdout, compare with
fixed baselines and run independent future-shadow evaluation. Recurring-session
forecasts and unseen-session placement have separate evidence requirements in
[the lifecycle contract](predictor-lifecycle.md). Check error/coverage by hardware,
context, cache tier and reasoning setting. The existing log-duration objective
does not automatically yield a mean duration after exponentiation; verify or
correct that before calling a score *expected* completion time.

When phase models are added, replace the aggregate estimate with their sum; do
not add prefill/decode on top of an already total-service prediction. Remote cache
transfer is a later compatibility-gated path whose critical path may overlap
queue wait. The [roadmap](roadmap.md) retains the four cache-source alternatives.
Genie may explain evidence and later request bounded training jobs; deterministic
evaluation/promotion and routing guards remain independent of his commentary.
## Fleet counters versus prediction analytics

The compact [hourly throughput tile](fleet-throughput.md) in the main status row
shows output with peak-hour, completed-request and prompt-reuse context beneath it.
It reads saved usage, not XGB forecasts; it is independent of the model and worker
filters in the prediction panel below.
