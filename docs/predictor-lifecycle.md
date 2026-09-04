# Predictors and Gate Genie

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
