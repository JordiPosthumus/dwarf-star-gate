# Predictors and Gate Genie

## Long jobs and output-limit censoring

Current normal-completion contracts exclude `finish_reason: length`, cancelled
work and unverified terminal responses. Those events remain in the raw dataset
but do not become training labels. The data audit reports `duration_evidence` by
duration band and terminal class, including observed service seconds; ambiguous
finish records are excluded. `normal_terminal` describes only the ending, not
eligibility under every other training gate.

Do not relabel output-limited work as natural completion. The next extension should
distinguish observed resource-occupancy duration from time to a natural answer,
retain the output-limit/cancellation cause, use causally known request limits and
validate long-duration holdout coverage separately. No existing feature contract,
training eligibility or routing threshold changes with this audit.

`predictor/occupancy.mjs` now implements a separate offline `dsg-occupancy-v1`
dataset contract. It reuses V4 causal snapshots, labels verified normal and
output-limited terminal service time, and excludes cancellation, relocation,
unmatched profiles and ambiguous finishes. Terminal class is label metadata,
never a feature. Existing natural-completion histories stay unchanged. This
contract is **not production-loadable**. An explicit offline trainer reuses the
reviewed forward-time feature/tree search and adds capped/normal holdout reports.
Long-duration future validation and activation review remain necessary.

Prepare a new private directory with `predictor/prepare.mjs --schema dsg-occupancy-v1`
and its usual `--data`, `--profiles`, `--output` arguments. Then use
`predictor/fit_v2.py --occupancy --prepared /private/output/prepared.json` in the
locked predictor environment. Without `--occupancy`, the trainer rejects this
target. The output is `occupancy-candidate.json`; the production runtime rejects
its distinct schema. No existing model or activation pointer is replaced.

Offline occupancy replay preserves all observed causal forecast points rather
than inheriting the live normal-completion history's rolling 68-point window.
It fails explicitly above 100,000 observed points instead of silently dropping
the early, longest remaining-time targets. Repeated points remain request-weighted
in training/evaluation; they are not independent jobs. The production history
window is unchanged.

Trainer reports include `target_coverage` for training, outer holdout and each
forward-time fold, separating points, requests and sessions by target-duration
band. For remaining-time models these bands describe time still remaining, not
total job duration; a request can appear in several bands. Hundreds of points
from one long session are not hundreds of independent long jobs. Check these
counts alongside error metrics: an aggregate improvement does not establish
long-job accuracy when training contains no long examples. These diagnostics do
not tune on the holdout, change promotion gates or authorize occupancy deployment.

### Delivery timing is not engine speed

An observed response can take substantial service time yet deliver its visible
content in a very short burst. Dividing all output tokens by the interval from
first visible content to completion measures **delivery rate**, not necessarily
DS4 decode speed. Transport buffering, visibility of reasoning and provider
streaming behavior cannot be distinguished from that timing alone.

The separate offline `dsg-occupancy-v2` contract (`dsg-delivery-aware-v1` features)
preserves the same occupancy labels and causal history, but names those rates
`prior_stream_delivery_tps` and `worker_stream_delivery_tps`. It retains the old
derived estimate as `history_delivery_estimate_s`, an optional learned input,
not a hard-coded generation-time anchor in the causal baseline. Three additional
history inputs describe the prior visible delivery window, its fraction of total
service time, and output tokens per full service second. The latter includes
prefill and other service time; it is not an engine decode measurement either.
Missing or inconsistent source times stay unknown. No hardware-speed cap is
imposed, no raw records are discarded, and no engine-speed measurement is invented.

Use the same preparation/training commands with `--schema dsg-occupancy-v2`.
It retains the bounded forward-time feature/tree/transform search and activation
gates. Both occupancy versions remain **offline-only**; original V1 and production
feature-builder contracts remain unchanged. Frozen future audits require the
exact matching version, builder and inventory, and reject legacy generation-anchor
keys in V2 rows. Keep old artifacts: this is a separate challenger, not a silent
rewrite of their inputs or historical scores. Correct semantics alone do not
prove better accuracy; compare matched data and freeze before future validation.

Changing the causal baseline also changes the opponent in the ordinary offline
holdout report. A newly passing gate can therefore reflect a weaker baseline,
not a better predictor. Compare both versions against the **same strongest
baseline** as well as their own reports before any activation review. In one
matched 250-request experiment, admission holdout MAE improved from 121.2 to
96.3 seconds, updated MAE worsened from 112.5 to 116.2, and remaining MAE barely
changed (56.3 to 56.0). The new remaining report passed its own offline gate and
also narrowly cleared the original baseline's 10% threshold (56.21 seconds).
That narrow margin is not strong evidence of general improvement. Every unseen-session
placement gate failed; there were no hour-plus holdout labels. Both artifacts
were frozen separately, not deployed. This is mixed preliminary evidence, not
a routing-speed improvement or a reason to retire deterministic fallbacks.

The first paired **future** check used 20 newly admitted, completed requests
across seven sessions, all admitted after both artifacts were frozen. Both
versions used one shared raw snapshot, identical labels/forecast points and
unchanged artifact hashes. Earlier evidence still supplied causal history; it
was not scored as new traffic. Request-balanced mean absolute error was:

| Forecast | Original occupancy V1 | Delivery-aware occupancy V2 |
| --- | ---: | ---: |
| Admission total service | 82.3 s | 82.3 s |
| Updated total service | 71.3 s | 73.1 s |
| Remaining service | 40.3 s | 40.1 s |

This did **not** establish an overall improvement. The two five-minute-plus jobs
were substantially underestimated at admission: mean absolute error was 330.8 s
versus 291.4 s, still poor for either version. There were no hour-plus jobs.
After those two jobs had already run for five minutes, remaining-time error was
42.2 s versus 43.2 s, over only 11 forecast points from those same two jobs.
That is a different age/target slice, not evidence that 11 independent long jobs
were handled well. All existing holdout and unseen-session gates still apply;
neither artifact was promoted. These are frozen offline replays, not logged live
forecasts or measured routing benefits. The inspected future cohort is now
research evidence, not an unseen test for any successor tuned using it.

The corresponding coverage audit counted **36 admissions**, not 20: in addition
to the scored completions, two completed on a different worker, six had failure
or cancellation terminal records, and eight had no terminal evidence in that
snapshot. The frozen label contract correctly abstained on changed-worker work.
Two queued cancellations had no `finish` record but were nevertheless terminal;
counting only `finish` events would have incorrectly grouped them with the eight
unresolved admissions. Completion-conditioned early results can underrepresent
long work; none of these counts establishes current liveness or retry safety.

### Frozen occupancy future audit

#### Experiments after a collector change

An all-history chronological split can put every newly collected feature in the
holdout and none in training/CV. Repeated ordinary retraining cannot teach a
feature that the training partition never sees. For an explicitly declared
collector-change experiment, occupancy preparation supports an admission-time
cohort:

```sh
node predictor/prepare.mjs --schema dsg-occupancy-v1 \
  --data /private/training --profiles /private/worker-inventory.json \
  --output /private/post-collector-experiment \
  --cohort-since 2026-01-01T00:00:00.000Z
```

Replace the illustrative timestamp with the independently recorded collector
activation time, chosen before comparing this experiment's outcome scores. This
is opt-in and restricted to offline occupancy experiments; ordinary preparation,
the live collector, model settings and activation gates are unchanged. Invalid,
future, duplicate or misspelled options fail instead of quietly changing the cohort.

Preparation still snapshots **all source bytes** and replays all events first.
Older completed requests continue to supply causal history. Only labeled examples
whose earliest admission is at or after the cutoff enter the experiment; later
progress on an older job cannot enter it. No outcome, duration or hardware-value
filter selects favorable cases. `snapshot.cohort` records the cutoff, selector
source hash and source/selected/excluded point and request counts. Empty cohorts
stay empty, and the existing snapshot/row budgets are not bypassed. Original
collector files and earlier candidates are not edited or removed.

Use the unchanged trainer and inspect fold support before interpreting accuracy.
Small cohorts can train yet still fail minimum holdout/session requirements; do
not relax those gates. Changing the experiment cohort makes a **new candidate**,
not a repaired score for the old one. Preserve the old freeze, freeze the new
artifact separately, and evaluate on genuinely later traffic. Already-examined
research data cannot become an unseen test for its successor.

#### Freeze, then evaluate later traffic

`predictor/occupancy_future.py` provides a separate offline check on genuinely
later traffic. First freeze the completed candidate and its original prepared
training file; then prepare another occupancy snapshot after new jobs finish:

```sh
python predictor/occupancy_future.py freeze \
  --candidate /private/audit/occupancy-candidate.json \
  --training /private/audit/prepared.json \
  --receipt /private/audit/future-freeze.json
python predictor/occupancy_future.py evaluate \
  --candidate /private/audit/occupancy-candidate.json \
  --training /private/audit/prepared.json \
  --receipt /private/audit/future-freeze.json \
  --prepared /private/later/prepared.json
```

Use the locked predictor environment. The private, exclusively created receipt
records freeze time and both artifact hashes. Changed artifacts, feature-builder
identity or worker inventory are rejected. A request must first appear after the
freeze, must not already occur in the prepared training set, and must finish by
the later snapshot. Later progress on an earlier-admitted job is not independent
future traffic. No available future labels means no accuracy score, not success.

Reports retain request-balanced errors, duration coverage, capped/normal slices
and fixed baseline rules: original-training worker means plus causal history. This is
**frozen-model replay**, not a record of predictions served live, a causal routing
experiment or promotion approval. It does not retrain, replace active artifacts,
change natural-completion models or relax their existing gates. Keep input files,
receipts and reports private; hashes bind local artifacts, not adversarially
tamper-proof publication certificates.

`input_support` distinguishes live telemetry **collected in the feature contract**,
**selected by this frozen model**, and **used in actual tree splits**. Training
and future point-coverage fractions are reported separately; no future rows means
unknown coverage (`null`), not zero observed coverage. Hardware is identified by
the contract's explicit hardware group, not a name prefix: hardware family and
hardware-history priors do not prove that RAM, power or activity telemetry is used.
Split counts are not feature importance or a causal benefit measurement. A model
trained before telemetry existed cannot learn from new samples without a separately
trained and frozen challenger. More telemetry alone does not validate that challenger.

`by_stage` also separates after-upload from after-embedding accuracy. The same
updated model can produce identical predictions at both stages if it selected no
inputs that change when embeddings arrive. Stage counts can contain the same job;
they must not be added and called independent requests. Use these diagnostics to
design the next training experiment, never to retune the frozen model on its
already-examined future cohort or bypass the activation gates.

For remaining forecasts, `by_elapsed` separately reports points made **before
30 seconds**, **from 30 seconds to five minutes**, and **after at least five
minutes** of service. These fixed diagnostic boundaries use the causal
`elapsed_s` feature, not the remaining target or eventual total duration.
Missing/unusable ages stay in `unknown`; empty slices have null scores, not zero
error. Each slice reports its point count and request-balanced model/baseline
errors, with unique request/session counts. The same job can enter several age
slices, so do not add their request counts. Changing populations and shorter
remaining targets also mean a lower error in an older slice is not by itself
proof that the model learned to recognize long work. This offline report includes
all retained progress points; it is not the UI's single first-at-or-after-30s plot.
It does not change feature builders, frozen artifacts, tuning or promotion gates.

Remaining reports also include `age_support`: for each scored point, how many
**distinct completed training jobs** had observed progress at least that far into
service? It reports fleet-wide and same-worker counts in fixed bins (none, one,
two–nine, ten or more, unknown age). Repeated progress from one job counts once;
run identity distinguishes reused request IDs. The source is only the frozen
model's training partition, never its holdout or later labels. Support uses
observed progress ages, not eventual duration reconstructed from future targets.

This is a diagnostic, **not calibrated confidence or an activation rule**. A
same-worker match does not certify the same hardware/profile era; missing late
progress can undercount support. A request can cross bins as it runs, so their
request counts must not be added. Missing age remains unknown and no compatible
training observation means zero observed support, not a fabricated estimate.

In a later paired replay, the delivery-aware candidate reduced admission MAE
from 86 to 65 seconds on 128 newly admitted completed requests, but the strongest
original causal baseline was still better at 57 seconds. Updated MAE stayed near
74 seconds; remaining MAE changed only from 43 to 42 seconds. These are frozen
offline occupancy candidates, not measurements of deployed routing benefit.

Five previously admitted requests also acquired labels after the earlier audit;
they are reported separately from new admissions. One took about 35 minutes,
while both models repeatedly forecast less than 90 seconds remaining. Beyond
15 minutes of elapsed service, their training partition had just **one distinct
completed job**, despite many progress points. The refreshed full cohort and the
new-admission cohort therefore answer different questions. Neither establishes
long-job reliability or justifies promotion. Next experiments should test
elapsed-conditioned remaining distributions and uncertainty, preserve the
strongest existing baselines, and reserve fresh traffic for independent validation.

#### Offline elapsed-conditioned residual-life experiment

`predictor/residual_life.py` tests a separate, deliberately simple alternative:
among completed training jobs on the same worker with total occupancy **greater
than the current elapsed age**, estimate their remaining time. Each job counts
once, regardless of its number of progress samples. It reports conditional mean,
median and empirical 10th/90th percentiles. Unknown age, unknown worker or no
surviving historical jobs produce an abstention, never a zero-time forecast.

```sh
python predictor/residual_life.py freeze \
  --candidate /private/audit/occupancy-candidate.json \
  --training /private/audit/prepared.json \
  --artifact /private/audit/residual-frozen.json
python predictor/residual_life.py evaluate \
  --candidate /private/audit/occupancy-candidate.json \
  --training /private/audit/prepared.json \
  --artifact /private/audit/residual-frozen.json \
  --prepared /private/later/prepared.json
```

Freeze uses the existing candidate's remaining-model training cutoff, purging
admissions whose final label was unavailable then. It writes a new private,
exclusive artifact bound to source, candidate and training hashes; it does not
refit XGB or replace a deployed model. Validate the prepared raw snapshot with the
coverage auditor below. Future scoring requires admission after this experiment's
own freeze, matching feature/profile contracts, and no training-request reuse.
Omit `--prepared` only for the explicitly labelled exploratory existing holdout.

Scores compare this experiment, frozen XGB and existing baselines on **the same
covered points**. Abstention counts and partially covered request counts remain
visible; age slices can share jobs. Empirical quantiles are not calibrated
confidence intervals: one survivor yields a zero-width interval with no reliability
guarantee. Completed-only history is not censoring-aware, and worker identity does
not certify the same engine/profile era. No cross-worker fallback is invented.

The first exploratory holdout was a clear negative result: 169 covered points
from 50 jobs, six abstentions; mean/median MAE about 225/139 seconds versus frozen
XGB's 58 seconds on those same points. Elapsed time alone does not make historical
jobs comparable. Keep this as an auditable experimental baseline, not a production
replacement; any richer conditional model still needs independent future testing.
Neither mode grants routing, promotion or recovery authority.

#### Check the denominator, not only the completed scores

Run the separate read-only census against the **same prepared snapshot**:

```sh
node predictor/occupancy-coverage.mjs --prepared /private/later/prepared.json
```

The tool verifies the manifest, raw-file hashes and current versioned feature
builder, reconstructs the exact prepared rows from full causal history, and then
counts admissions using the snapshot's declared cohort cutoff. It neither makes
a new raw copy nor changes prepared files, frozen models or labels. It supports
both offline occupancy versions; no production endpoint or model is contacted.

Every unambiguous in-cohort, non-Genie admission is assigned once to labeled
completion, complete without a usable label, noncomplete terminal, no terminal
evidence, or conflicting lifecycle. Duplicate event copies do not inflate counts;
ambiguous admissions and orphan lifecycles are reported separately because their
cohort membership cannot be established. Queued cancellation, queue timeout and
pre-dispatch unavailability are terminals even without a `finish` event.
Changed-worker completion is not mislabeled as request failure or given the
original worker's training label. Other label exclusions remain explicitly
unclassified instead of inventing a diagnosis.

For admissions without terminal evidence, the report distinguishes whether a
dispatch was recorded, and shows admission-age bands. **Admission age includes
queue time**; it is not service age, a remaining-time estimate or proof of a stall.
A missing terminal record may mean in-flight work or incomplete observation.
Even a client cancellation does not prove backend generation stopped. The census
does not authorize retries, recovery or model promotion.

Output is aggregate-only: no request/session/worker identifiers, prompt text,
vectors, raw backend errors or private paths. Keep operational reports private.
Input limits are explicit: 128 MiB each for prepared JSON and total raw routing
bytes, 1 MiB inventory, 200,000 events, 20,000 lifecycle keys and 4,096 manifest
files. Exceeding a limit rejects the audit, never truncates evidence or pauses
collection/inference. Unterminated tails are counted but not parsed, matching
preparation; malformed complete lines, changed rows/bytes, invalid lifecycle
identities, final-component symlinks and path-escaping manifest entries reject.
Counts describe captured files and complete lines, not a complete fleet history.

## Current lifecycle

Implemented, opt-in. Ordinary routing remains the default. A fitted model is
experimental until it passes both a fixed backtest and an independent future
shadow gate. This feature does not promise that the available data will pass.

- DSG computes forecasts from a versioned, shared offline/live feature builder.
  Admission uses past completed calls only. Upload/embedding updates and active
  remaining-time forecasts have separate timestamps and evaluation targets.
- Features include recent output/duration trends, variability, ratios, shared
  hardware attributes, queue/load age, candidate cache/session evidence, optional
  early client counters, bounded request shape, semantic projections/similarity,
  and observed generation phases. Character counts are not called token counts.
- Python/XGBoost trains off the request path with fixed CPU/time/data budgets.
  Immutable candidate bundles carry source, schema, inventory and data hashes.
  Native JavaScript tree evaluation must match the Python model numerically.
- Tree count and feature-family selection use forward-time folds within training,
  purging labels not yet completed at each cutoff. Recurring sessions are allowed:
  the target is the next request using only its available history. No session ID
  enters the model. A separate unseen-session gate is required for new-session
  placement. The later holdout is not used to select trees/features. Future shadow
  evidence is the independent release gate, including after development experiments.
- Admission service time, updated service time and remaining busy time are
  distinct forecast contracts. Missing features or unsupported hardware produce
  abstention, not fabricated confidence. Queue wait remains derived from active
  remaining time and work ahead.
- GG sees accuracy, coverage, current versions and executor receipts. It can
  request a bounded training job or rollback, not run shell commands, choose
  arbitrary models, alter gates or invent evidence. Automatic training can work
  without GG. Switching GG off does not secretly disable other automation.
- Collection, automatic training, validated forecast activation and routing use
  are separately visible. Candidate forecasts are explicitly experimental.
  A named default baseline and **Reset to baseline** keep recovery distinct from
  turning learning off. Qualified promotions create persistent, dismissible
  learning milestones with independently measured evidence and optional Genie commentary.
  Existing healthy session affinity, queues, context, inference settings and
  model-server configurations are preserved.
- Prediction-assisted placement applies only where its support is established;
  unknown costs retain the existing deterministic placement. No active-stream
  migration, cache movement or automatic replay is introduced by this feature.
- All model artifacts, training evidence and operational action history are
  private ignored runtime files. The public repository ships implementation,
  synthetic tests and generic configuration, not fleet data.

Evaluation must report coverage, error in seconds, bias and long-request error,
per hardware and forecast stage. A log-duration prediction is not automatically
an arithmetic expectation. No model is called better merely because it fitted,
reloaded or produced an attractive chart. Sparse data can legitimately block
promotion; collecting more evidence must not mean relaxing the tests.

New training reports split target duration into under five minutes, five minutes
to under one hour, and one hour or longer, for candidates and every baseline.
Each band shows unique requests, forecast points, MAE, signed bias and mean
actual/predicted seconds. Progress points are request-balanced within each band;
empty bands report null accuracy, not zero error. For remaining forecasts these
are **remaining target seconds**, not total request age; a request can contribute
to more than one band as it progresses. These are diagnostic slices, not new
selection or activation gates. Unfinished requests have no final label and are
not included: live long-occupancy warnings remain essential.

## Three forecast contracts, one lifecycle

| Contract | Available evidence | Target |
| --- | --- | --- |
| Admission | Prior completed requests, worker identity/hardware, current queues, cache/session ages, optional early client counters | Total server seconds after dispatch |
| Updated | Admission history plus bounded upload shape (message/role/text/image/tool counts and output controls); later a separately timestamped embedding update | Same total server duration, predicted later |
| Remaining | Elapsed time, emitted character counts/phase and then-available metadata/embeddings | Successful server duration minus elapsed |

The UI separates upload and embedded updates. Its remaining-time chart freezes
the first forecast at or after 30 seconds; it does not replace that forecast with
a more accurate late one. The trainer weights progress rows so a long request
has the same total weight as a short request. Future promotion averages errors
within each request before averaging requests. Those evaluation windows differ
deliberately and are labelled. Queue-wait charts retain the existing historical
baseline. The optional placement cost sums active remaining time, queued service
estimates and the incoming service estimate; these are not added to total service
again as separate prefill/decode costs.

### First request and hardware changes

Previous duration, output, prompt and thinking values stay `null`; history count
is zero. XGB uses missing-value branches, not a fabricated previous call. Priors
fall back from the server's recent same-profile history to matching hardware,
accelerator, RAM and context, then the verified fleet's recent history. If none
exists, the live baseline is unknown. A relative-log transform uses a neutral
positive mathematical anchor when all priors are missing; this is not exposed
as a one-second latency estimate. No fixed 60-second latency is imputed.

Identity and hardware family are separate categorical features. New/unverified
workers are not automatically calibrated by resemblance. The private inventory
must match the collector's endpoint/model/context fingerprint. Add new profiles
after verifying hardware and reload DSG to load the revised inventory. A profile
mismatch abstains. Engine build/cache settings are **not** in this fingerprint;
significant changes require clearing predictor activation through Rollback and
collecting fresh evidence, not assuming old calibration still applies. Model
settings and inference limits are never changed by this subsystem.

## Install / reproduce

Prepare the existing private inventory described in the
[v1 experiment documentation](../predictor/README.md#identity-plus-hardware-family).
Keep it under ignored `runtime/`; never commit inventory or learned models.

```sh
uv sync --locked --project predictor
npm run predictor:test
node predictor/prepare.mjs --data runtime/training \
  --profiles runtime/worker-profiles.local.json \
  --output runtime/predictor/candidates/candidate-example
uv run --locked --project predictor python predictor/fit_v2.py \
  --prepared runtime/predictor/candidates/candidate-example/prepared.json
```

Output directories must be new. Each stores frozen source evidence, prepared
features, the evaluated `candidate.json`, and a checksummed `report.json`.
Export uses numerical trees, not pickle or executable model code. The exact
evaluated forest is exported, not an unevaluated all-data refit. JS inference is
tested against the pinned Python XGBoost runtime, including float32 accumulation,
missing values, category encoding and log back-transformation.
New model IDs bind the forest, forecast contract, frozen snapshot and release
time. Identical-looking retrains do not inherit an older release's validation
evidence. Existing stored artifacts remain unchanged.

`dsg-latency-v2` remains loadable and byte-compatible while
`dsg-latency-v3` trains as a challenger. A V3 model cannot inherit V2 validation
or replace it on a restart. The status API reports each candidate's schema,
selected blocks, full-contract feature coverage and winning-tree split usage.
Reports separate training and future-holdout feature coverage. V4 hardware
coverage is also broken down by worker and prediction stage, with request and
sample-point counts. Coverage fractions are point-based, not request-balanced;
valid zero readings count as available, while missing/non-finite readings do not.
These are diagnostics, not additional promotion gates or evidence of routing gains.
Historical evidence cannot backfill new request-shape fields; those become useful
only after the V3 collector runs.

Merge this optional block into `config.local.json` without changing other settings:

```json
{
  "dataset_enabled": true,
  "predictor": {
    "enabled": true,
    "python": "predictor/.venv/bin/python",
    "profiles": "runtime/worker-profiles.local.json",
    "automatic_training": false,
    "automatic_promotion": false,
    "placement": false
  }
}
```

Relative local paths resolve against the config file. Run `npm run doctor` and
restart the gateway and dashboard in an approved maintenance window. No model
server restart is required. Embeddings have their own explicit configuration;
missing/failed embeddings do not interrupt inference. Once created, persisted UI
policy in `runtime/predictor/state.json` wins over initial config defaults.

## Fixed selection and release gates

- CPU-only: XGBoost 3.4.1, NumPy 2.5.2, two XGB threads, shallow depth-2 trees.
  Cross-validate 16/64/128 trees, raw/log/relative-log targets, and reviewed,
  bounded feature-block combinations. V3 separates stable base, admission/cache
  state, client counters, history/ratios, request shape, semantic and progress
  blocks so noisy evidence is available without being forced into every model.
  Relative-log models use the causal prior even when the selected tree inputs
  are only the base family. Full vectors stay private; semantic features include
  12 fixed projections plus previous-turn similarities. Selection may reject
  embeddings if they do not improve the inner-fold score.
- At least 50 unique successful requests, 25 training and 10 holdout requests,
  and two usable forward-time inner folds to fit. Categories fit training only.
- Backtest promotion: at least 20 holdout requests across 3 sessions, MAE at
  least 10% better than the best fixed comparison (worker mean, recent session
  mean, causal hardware/history prior), and aggregate predicted/actual mean
  ratio 0.7–1.3. Report long-request and per-worker errors separately.
- Future gate: at least 30 requests across 5 sessions admitted **after artifact
  creation**, 10% MAE improvement over the causal history fallback, ratio
  0.7–1.3, at least 5 results on each observed worker and no worker MAE worse
  than 1.1× fallback. Require 3 long requests if the holdout included long work.
  The status API preserves the stable outer `baseline_gate_pending` state and
  includes a bounded `promotion.gate` reason such as `future_requests_pending`,
  `future_worker_coverage_pending`, or `future_long_tail_pending`. This explains
  missing evidence without exposing sessions, prompts, embeddings or training
  rows, and it does not relax or bypass any gate.
  Active forecasts still abstain on workers/profiles lacking local future support.
- If a model is already active, the challenger must **also beat that incumbent
  policy** by 10% on matched future requests and the exact same forecast points,
  with the same count/session/calibration/worker gates. Where the incumbent itself
  abstains, its baseline fallback is the comparator and those points are counted
  explicitly. Old incumbent errors from different traffic are not a comparison.
  Existing saved evaluations lacking paired evidence cannot satisfy this new
  gate; they are retained, and fresh traffic supplies the missing evidence.
  A zero-error baseline tie is not an improvement and does not earn promotion.
- New-session placement additionally needs 20 unseen-session holdout requests
  across 3 sessions passing the same gain/calibration test, plus 5 first-observed
  training requests per candidate worker. First-observed is **not** proof of a
  physically cold cache. Every candidate cost must be supported; otherwise use
  ordinary deterministic routing. Busy costs require a validated remaining
  forecast no older than 60 seconds, and all queued costs must be validated.
- Remaining forecasts abstain beyond the training worker's observed elapsed-time
  range. Long unsupported work is not confidently assigned zero time remaining.

These are practical guardrails, not statistical proof of optimal routing.
Observational data does not reveal what an unchosen server would have done.
Success-only labels exclude errors, cancellations, truncations and incomplete
requests; reliability continues to be tracked separately, never hidden in latency.
The graph's selected-stage coverage and the model's future evidence counts should
be inspected alongside MAE, not just a pooled score or an attractive chart.

## Controls, GG and rollback

Under **Analytics → Predictor lifecycle**:

- **Train candidate:** one bounded background job, no activation bypass.
- **Auto training:** with at least 50 new completions, the scheduler can train
  every six hours. GG may request an offered training run sooner, with a ten-minute
  offer cooldown and the same data/budget rules. Manual requests have a one-minute
  cooldown. An offline-qualified shadow candidate gets up to six hours to gather
  its 30-request/5-session release sample before automatic/Genie retraining can
  replace it. Only one trainer runs at once.
- **Auto validation:** promote passing frozen candidates without a user prompt.
  This does not automatically enable placement.
- **New-session placement:** arm validated placement independently. With no
  eligible model it has no routing effect. Healthy existing affinity is unchanged;
  no queued/active job is migrated or replayed.
- **Rollback:** return to the prior non-rejected version, otherwise deterministic
  fallback. The independent watchdog rolls back after 20 recent requests across
  at least 3 sessions show MAE above 1.25× fallback. GG may request an offered
  rollback at 1.1×; offers are rechecked when executed. Rejected versions are not
  silently promoted again.
- **Reset to baseline:** restore `causal-history-v1` for all three forecast
  contracts and clear the previous-version pointers. This is the existing fixed
  causal history/hardware recipe, not a newly invented XGB default or a fixed
  guessed duration. Its observations keep updating; unavailable evidence is
  still unknown. Ordinary deterministic routing remains the fallback. Reset
  rejects the active/current shadow versions and requires a newly captured
  snapshot plus fresh validation before another promotion. A snapshot prepared
  before reset cannot immediately undo it. Collection, retained data, training
  already in progress and the auto-training/auto-validation/placement switches
  are **not** disabled or changed. No server, queue, session or cache is changed.

### Durable learning milestones

Activation and its pending announcement are stored together in private predictor
state. The UI shows the forecast kind/version, evidence count and servers,
baseline MAE, matched incumbent MAE when applicable, and the time of promotion.
Announcements have no timeout and survive browser/dashboard/gateway restarts;
only an explicit operator dismissal acknowledges one. Reset or rollback does
not erase the historical achievement. Dismissal changes neither model selection
nor learning, and the append-only action journal retains the original evidence.

The fixed validator creates the facts even when GG is unavailable. During an
ordinary review, Genie may add short, lightly humorous **labelled commentary**
to an existing unannotated milestone. It cannot create promotions, edit evidence,
acknowledge announcements or change tests. This uses the same review call, not
another inference request. The health ticker remains sober operational advice.
Duplicate activation is rejected; a failed state write produces neither active
model nor a false success announcement. Better prediction accuracy is explicitly
**not** presented as a measured improvement in routing completion time.

GG receives versions, error/coverage evidence, forecasts, offers and executor
receipts. It does not receive vectors or raw prompt text from this feature. It
cannot supply commands, paths, new algorithms, arbitrary hyperparameters or gate
changes. The one additional commentary action accepts a pending milestone ID and
plain text only; it grants no model-management authority. A training request is not a successful model, and model activation is
not proof that placement is enabled. The UI shows actual receipts. Turning GG off
does not disable collection, forecasting or the separately armed automations.

Training has a 120-second overall budget (snapshot stage capped at 30 seconds),
128 MiB source snapshot and 100,000 prepared-row limits. Exceeding those budgets
fails explicitly; **no training input or stored user data is silently deleted**.
As history grows, a reviewed rolling training-window policy will be needed; this
version does not silently choose a retention policy. Failures keep the last
working model/fallback and save a bounded private failure log. Restart interrupts
training rather than activating a half-written candidate. Runtime history is
bounded; on startup it replays up to 8 MiB from each of the last two daily files,
and discloses partial history. Source evidence remains on disk.

UI/control APIs use the existing loopback, same-origin CSRF and local control
socket boundaries. Checksums protect artifact consistency, not against a malicious
operator who can edit both code and private state. Native model evaluation is
small and synchronous; Python training, embeddings and GG are never awaited by
request forwarding. The gateway retains its existing session ownership and one
active request per registered DS4 server.

## Reviewed training recipes

The UI selector and GG's exact offered actions can choose `standard-v1` (unchanged
depth-two default), `regularized-v1` (larger leaves/stronger regularization), or
`interactions-v1` (depth three, stronger regularization). The shared
[recipe definitions](../predictor/recipes.json) accept IDs only, not supplied
parameters, commands or gates. One recipe per job; no sweep of all offers.
These are alternatives, not claims of improvement. Scheduled training keeps the
standard default; GG may choose another when an eligible offer exists.

Every choice **cross-validates 16/64/128 trees** over the existing feature-family
and target-transform combinations using purged forward-time training folds.
Later holdout, future-live, matched-incumbent and unseen-session gates are unchanged.
Two CPU threads, the 120-second total budget and data limits remain fixed. UI
selection affects one run, not a permanent production setting. Artifacts record
recipe ID, policy checksum and actual parameters; receipts record the choice.
Legacy artifacts without recipe metadata still load. Existing feature definitions,
trained models and collected evidence are preserved.

## Next learning work and current boundaries

- [Early client hint collection](client-metadata.md) is implemented. The V3
  contract now exposes those counters plus bounded request-shape and
  admission/cache clocks to separately cross-validated challengers. Clients that
  do not send the header remain valid with explicit missing values. No V3
  challenger influences placement until its own holdout and future-live gates pass.
- Reviewed training-window selection remains future work. Recipe choices do not
  silently shorten retained history. Independent evidence, baseline and
  compute/privacy limits stay outside GG's control.
- Rejected artifacts remain inert. Status exposes bounded rejection categories
  (for example checksum, feature-builder, recipe, parity or invalid-artifact
  mismatch), never trainer output or private paths. A newly produced artifact
  writes that category into its private failure record so an operator can
  distinguish a validator mismatch from a trainer crash without weakening the
  validator.
- Add manual and optional hourly development calibration **only after** proving
  it cannot displace warm production caches or compete with admitted work.
  Automatic calibration skips on uncertainty. Idle alone does not prove a free
  cache slot. [Read-only preflight](calibration.md) exposes skip reasons; there is
  still no request runner/hourly toggle. Training uses recorded traffic, not DS4.
- Improve DS4-specific measurement extraction under the
  [stock DS4 integration contract](ds4-integration.md). No DS4 source patch,
  custom binary, model-setting change or server restart is part of this feature.
