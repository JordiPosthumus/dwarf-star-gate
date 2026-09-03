# Offline XGBoost experiment

**Implemented: fit, evaluate, save, reload and inspect an experimental predictor.**
**Not implemented: live prediction, routing changes, automatic promotion or a
production XGBoost fallback.** No gateway restart or GPU inference job is needed.
The normal deterministic router remains entirely unchanged.

## What the first target means

Predict **service seconds after dispatch**, using `log1p(service_seconds)` as the
training target and transforming predictions back to seconds. This includes
upload/backend waiting, cache restoration, prefill and generation as observed by
DSG; it is not pure decode time. Queue waiting in DSG is excluded from this target.
A later completion-time scheduler must estimate waiting separately and add it.

The first fit uses fixed, small CPU settings: 32 boosting rounds, depth 2, seed 42,
two XGBoost threads. It does not search hyperparameters on the holdout. Dependencies
are isolated and locked: Python 3.12–3.14, XGBoost 3.4.1, NumPy 2.5.2, with the
transitive dependency resolution in `uv.lock`. macOS needs an available OpenMP
runtime for the XGBoost wheel; installation is not part of starting DSG.

The first fit is a **plumbing smoke test**, not a cross-validation exercise. Its
tiny chronological holdout is only an optional diagnostic, not a claim that tree
count is tuned. For the production predictor, tree count (`ntrees`, expressed as
`num_boost_round` here or `n_estimators` in the sklearn API) **must be selected by
cross-validation inside training data**: forward-time, session-separated folds,
with only labels available at each cutoff. Early stopping must use fold-internal
validation, never the final test set. Refit with the selected count and assess on
an untouched later-session test set. Save the fold definitions and selection
evidence. This production selection pipeline is **not implemented yet**; the
32-round smoke model and ordinary routing are unchanged.

## Reproduce a fit

From the repository root, with `uv` installed:

```sh
uv sync --locked --project predictor
npm run predictor:test
uv run --locked --project predictor python predictor/train.py \
  --data ./ds4-gateway/runtime/training \
  --profiles ./ds4-gateway/runtime/worker-profiles.local.json \
  --output ./ds4-gateway/runtime/training/candidates/experiment-001
```

The input/output paths above are private deployment paths, not public sample data.
The output must not exist: candidates are immutable. Each run reads fixed initial
file sizes, saves the exact snapshot bytes and inventory, and trains on that
snapshot. New live events belong to a later run. The snapshot budget is 256 MiB;
larger inputs fail explicitly rather than silently sampling or exhausting memory.
This limits offline training only, not the live collector or inference capacity.

The output directory contains:

- `model.ubj`: actual XGBoost candidate refitted on all eligible snapshot rows.
- `features.json`: exact feature order and training-fitted categorical vocabulary.
- `report.json`: exclusions, coverage, evaluation versus median baseline, versions,
  parameters, warnings, numeric training ranges and save/reload verification.
- `evaluation-model.ubj` and `evaluation-features.json`, when a valid split exists:
  the distinct training-only model used to produce holdout metrics.
- `rows.jsonl`: numerical/categorical training rows with request/group identities.
- `snapshots/`: reproducible private source evidence and hardware inventory.
- `manifest.json`: artifact hashes, trainer/preprocessor/dependency-lock source
  hashes and explicit `routing_enabled: false`.

Replay a published-format bundle's captured inputs with the same checkout and
locked environment, without rereading the live collector:

```sh
uv run --locked --project predictor python predictor/train.py \
  --data ./ds4-gateway/runtime/training/candidates/experiment-001/snapshots \
  --profiles ./ds4-gateway/runtime/training/candidates/experiment-001/snapshots/worker-inventory.json \
  --output ./ds4-gateway/runtime/training/candidates/experiment-001-replay
```

Tests verify identical model bytes and evaluation reports for a same-environment
snapshot replay. Bitwise reproducibility across different platforms/library
versions is not promised.

No pickle is used. See [XGBoost's model-IO documentation](https://xgboost.readthedocs.io/en/stable/tutorials/saving_model.html)
for the distinction between model files and runtime memory snapshots. Our
preprocessing and provenance are deliberately saved alongside the model.
Checksums detect accidental mismatch/tampering; they are not signatures or a
reason to load an untrusted model bundle.

## Identity plus hardware family

Server identity and hardware category are **separate categorical features**, not
ordinal numbers. A new server may be unseen while its hardware family is familiar.
Example private inventory structure:

```json
{
  "schema": 1,
  "observed_at": "2026-09-02T00:00:00Z",
  "workers": {
    "example-worker": {
      "hardware_family": "spark_gb10",
      "accelerator_family": "nvidia_gb10",
      "ram_gib": 120.0,
      "matching_profiles": ["REPLACE_WITH_THE_ACTUAL_64_HEX_COLLECTOR_PROFILE"]
    }
  }
}
```

That RAM value is illustrative. Supply OS-reported total memory in GiB, **not free
RAM** and not an unexplained marketing capacity. The current private profile
inventory is supplied by the operator/read-only probes; it is not auto-discovered
or embedded in live collector records yet. Fingerprint mismatch excludes the row
instead of silently attaching a changed worker's metadata. An absent inventory
entry stays unknown, never guessed from a friendly name.

Historical enrichment uses today's verified static hardware inventory and is
marked as such. A matching endpoint/model/context fingerprint is not proof that
hardware, engine settings or caches never changed. Future collection should attach
versioned hardware/engine identities at observation time. New hardware without
observed outcomes cannot be declared calibrated merely because its RAM is known.

The inference server's RAM is distinct from the calling laptop's RAM. Client RAM
is not collected here; it is usually not a direct explanation of server compute
time, although client/network backpressure may affect observed durations.

## Exact version-1 features

Categorical: `server_id`, `hardware_family`, `accelerator_family`, `affinity`.

Numerical:

- `ram_gib`, `context_length`;
- `selected_active`, `selected_queued`, `assigned_sessions`;
- `fleet_active`, `fleet_queued`, `fleet_free`, `fleet_size`;
- `observed_session_requests` (prior gateway requests, **not user-turn count**);
- `prior_prompt_tokens`, `prior_completion_tokens`, `prior_service_s`,
  `prior_cached_fraction`, `seconds_since_prior_completion`.

Prior-result features are usable only if that result finished **before** the
current request's decision time. An overlapping request's eventual result cannot
leak into its neighbor's features. The current request's prompt usage, output
length, thinking metadata, byte count and outcome are **not input features**:
this collector version does not expose them at initial placement. Missing values
stay missing. No turn counts, compaction metadata, embeddings, current GPU/RAM
utilization, actual cache residence, or engine-epoch features are fabricated.

This intentionally limited predictor is not yet a per-prompt workload estimator.
Current-request features should be instrumented at the actual prediction point
before adding them, using the same feature contract in training and serving.

## Evidence and evaluation rules

- Join by process-run ID and request ID. Deduplicate identical events; reject
  conflicting IDs, incompatible schemas and malformed complete lines.
- Skip/report a partial trailing line from a live snapshot. Missing lifecycle
  events stay incomplete. Never create synthetic successes to fill a dataset.
- Use only successful `stop`/`tool_calls`/`function_call` finishes with valid
  service time. Exclude failed, cancelled, unknown/truncated finishes, declared
  observer requests, missing/truncated candidate snapshots and profile mismatches.
- Evaluate on the latest decision-time block, with its entire session groups
  removed from training. Also remove training labels that had not finished before
  the holdout cutoff. Unknown session IDs share one conservative unknown group.
- If this leaves too little data, report evaluation unavailable. Do not substitute
  a random row split. Category vocabulary fits the training fold only.
- Compare against the training-set median service time, with MAE in seconds.
  Holdout metrics belong to the evaluation model, not the all-rows refit.
- `evidence_sufficient` is only a coarse report flag (100 rows, 20 groups, 20
  holdout rows). Even passing it **does not authorize routing** or prove coverage
  of every server/context/cache regime. No activation API exists in this package.

## Inspect a saved prediction

Create private input JSON with `schema: "dsg-service-decision-v1"` and `features`
containing exactly the keys above (null for unavailable fields), then:

```sh
uv run --locked --project predictor python predictor/predict.py \
  --bundle ./ds4-gateway/runtime/training/candidates/experiment-001 \
  --input ./ds4-gateway/runtime/prediction-input.json
```

The loader checks artifact hashes, schema and feature order. Output is explicitly
experimental and includes unknown categories and out-of-training-range numbers.
An unseen identity gets a reserved unknown category; there is no arbitrary
numeric encoding of machine names. Shared class features can transfer signal,
but do not guarantee good predictions for an unseen server or hardware family.

Tests cover leakage, missing/censored evidence, profile mismatch, schema errors,
unknown workers, time/group splits, save/reload equality and checksum failures.
CI uses synthetic fixtures only. Real data, inventory and fitted artifacts remain
private and Git-ignored; the public privacy check rejects those files if staged.

## Interpreting an experiment

Fit/save/reload success validates plumbing, not prediction quality. Read the
candidate's private report: eligible rows, independent session groups, excluded
evidence, hardware coverage, purged training rows and held-out error versus the
median baseline. A model worse than its baseline must not be promoted. A tiny
holdout is inconclusive even when the model happens to win.

Each candidate describes its frozen input snapshot. Later collection does not
update that model automatically. Keep numerical operational results, inventories
and fitted bundles private; public documentation explains reproducible procedures
and synthetic tests, not the state of an individual's experiment.

Operational failures are excluded from the successful-service-time target, but
must remain visible in the collector and operations UI. In particular, a fatal
CUDA worker error is not a slow successful request and must not be delegated to
this predictor to diagnose, hide or recover. Model-list probes alone do not prove
generation readiness. The gateway now implements
[failure-aware quarantine](../docs/generation-health.md), independently of this
offline package; the predictor does not diagnose or recover workers.
