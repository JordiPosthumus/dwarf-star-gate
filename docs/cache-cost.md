# Cache acquisition: measured component baseline

**Implemented, read-only, unvalidated. No routing or cache mutation.** The
Analytics view includes a cache-cost calculator for one hypothetical server,
cache tier, cached-prefix length and total prompt length. It uses the existing
DS4 timing feed; it does not call an LLM, copy a cache, or run a benchmark.

The useful decision is eventually: **wait for the hot server, restore a local
snapshot, fetch a remote snapshot, or prefill cold**. Choose the safe feasible
option with the shortest expected completion time, not merely the highest
decode speed. This first calculator supplies measured components of that decision.

## What is measured

| Component | Evidence and current estimate |
| --- | --- |
| Local disk payload load | DS4 `kv cache hit ... tokens=... load=... ms`; mean of comparable recent observations on this server |
| Suffix or cold prefill | A matching observed `prompt start` / `prompt done` pair, including cached, total and new-token counts |
| Hot lookup / synchronization | Unknown; not silently assumed free |
| Remote transfer and import | Unknown; no transfer calibration or compatible-cache inventory yet |
| Queue and generation | Separate costs, not included in this calculator |

The disk timer in [Antirez's KV implementation](https://github.com/antirez/ds4/blob/main/ds4_kvstore.c)
starts after prefix search. It includes file opening, validation/payload loading
and related work inside that function; it does not prove that later engine
synchronization is covered. Consequently `total_acquisition_ms` remains null.
`measured_components_ms`, when present, sums only the observed load/prefill parts.
Do not add those parts to an end-to-end service estimate that already includes them.

Per server, retain at most 128 samples from the last hour. Estimates require at
least three observations in the same power-of-two token-size bucket. Prefill
also matches the total-prompt bucket and whether any prefix was reused; warm
prefill observations are not cold-prefill labels. The arithmetic mean and
observed min/max are descriptive estimates, **not confidence intervals**. No
cross-server pooling, rate extrapolation or semantic-similarity lookup occurs.
Restarting the dashboard rebuilds observations from its available log tail.

## Important limitations

- A scenario does **not** establish that its cache exists, is resident, is
  compatible, or belongs to that request. Similar text is not KV identity.
- Systemd journal timing events now carry a privacy-safe backend process epoch.
  A local stock DS4 log may carry a weaker, bounded epoch when its timestamped
  listen marker is present in the latest bounded startup scan. A proven epoch
  change clears component samples, so those observations do not mix process
  lifetimes. Missing service/marker evidence remains unknown. Timing events still
  lack a protocol request ID; the separate correlator can only produce bounded
  candidates, so these remain component observations rather than cache-hit labels.
- Missing, sparse or stale measurements produce **unknown**, never a zero cost.
  A disconnected feed, unhealthy server or stale gateway snapshot rejects the
  calculation. Scenarios cannot exceed a known worker context capacity.
- Direct traffic may also appear in engine logs. The estimator does not attribute
  it to DSG or accuse a particular route of causing a miss.

For local integrations, `GET /api/cache-cost` on the dashboard takes `worker`,
`tier` (`local_disk`, `cold`, `hot`, `remote`), `cached_tokens`, `prompt_tokens`.
It is same-origin/read-only and exports numerical component evidence, not paths
or request text. Deployment data remains private even when this API is local.

## Next evidence, not another speculative model

Follow the [stock DS4 integration boundary](ds4-integration.md): extract existing
API/log/OS evidence, without editing the engine. If attribution cannot be proved,
keep the component estimate and the uncertainty; do not force a guessed join.

1. Measure the implemented shadow correlator's yield across real backend process
   epochs, preserving every ambiguity and direct-traffic conflict as an
   abstention. Exact protocol identity remains unavailable.
2. Inventory compatible snapshot identity and measure lookup/restore/import
   boundaries, including real cold-to-warm verification.
3. Evaluate estimates against later observations; add uncertainty and abstention
   by hardware, context and cache regime.
4. Compose acquisition, residual busy time and generation costs in shadow.
   Only then consider a cache-aware handover policy.

Unit tests exercise span matching, freshness, sample bounds, distinct cold/warm
regimes, unknown tiers, API validation and unchanged read-only authority.

## Validate component forecasts without borrowing the answer

An offline study should distinguish three different claims: a descriptive fit to
history, a chronological replay using only prior observations, and a forecast
scored on traffic that arrived after the evaluator was frozen. Only the last is
genuinely later validation of the frozen study. None proves a routing speedup.

For prefill, freeze the existing baseline's estimate when `prompt start` is
observed, using its known cached/new/total token counts. Match the later
`prompt done` only within the same evidenced process epoch and unambiguous span.
Do not update the estimate with its own completion. Keep journal fractional
milliseconds; they are not malformed integer timestamps.

Observer timing matters too. Entries collected in the same observer tick must
not train one another's frozen forecasts; a start and completion first observed
together are not evidence of an online prediction opportunity. Preserve them as
historical component observations, but disclose their exclusion from scored
opportunities. Unknown epochs, overlapping starts, conflicting duplicates and
incomplete spans must not become invented matches or zero-cost labels.

Report coverage as well as error, separately by server and cold versus reused
suffix prefill: eligible opportunities, scored opportunities, insufficient
history, mean absolute error, signed bias and large-error behavior. The current
three-sample, one-hour, token-bucket baseline can be accurate on a narrow subset
while abstaining elsewhere. Missing predictions do not count as successes, and
better subset accuracy does not justify weakening identity or freshness checks.

Disk-load validation needs a different checkpoint: the restored token count may
only be reported after the load. Selecting comparable past loads using that
completed event is a retrospective component check, not a pre-load forecast.
Do not mix it into the start-time prefill score or claim a cache-path decision.

Retain private source hashes, exact evaluator/baseline versions, cohort boundary
and exclusions. Freeze those before collecting a later scoring cohort; earlier
observations may train the unchanged rolling baseline but are not future test
rows. Keep deployment results private. This protocol does not add a live
collector, change sample retention, fit an XGB model or relax activation gates.

### Evaluate gap filling separately from replacement

Broader prediction coverage is not sufficient reason to replace the local
baseline. Compare a candidate against it on exactly the spans where both predict;
report candidate-only coverage and errors separately. A worker/regime training
median is a useful simple comparator, not a substitute for the matched baseline.

One offline hypothesis is **baseline first, candidate only when it abstains**.
Select the candidate recipe using chronological training-only validation, purging
labels not yet completed at each cutoff. Inspect development results once, then
freeze both model and combination policy before later traffic. Do not rename an
inspected development partition as future validation or retune on that future
cohort. Unknown workers and invalid features still require abstention.

Private later-traffic checks have now exercised this frozen policy without
refitting. The first cohort supplied only candidate-only error evidence, not a
matched-baseline result. A second disjoint cohort added shared opportunities:
the candidate was less accurate than the baseline there, and a candidate-only
cold span exposed a severe error. This candidate is rejected for activation,
including unqualified gap filling. Small and uneven regime partitions remain
limits, not reasons to discard the adverse evidence. Deployment records, source
captures and model artifacts remain private.

For each later capture, verify model, feature-builder, evaluator, baseline and
runtime versions against the frozen records. Use the latest applicable model,
evaluator or combination-policy freeze as the score boundary. Retain earlier
observations only as causal rolling-baseline history. Check that repeated samples
cannot move their first observation later and change which labels were available.
Instrumented row extraction must reproduce the unchanged baseline on the same
cohort; adding candidate features must not change its estimates or eligibility.

Report an empty shared partition as count zero with unknown error metrics, never
zero error or a percentage improvement. Keep candidate-only, shared and overall
descriptive scores separate, including worker/regime counts, known versus unseen
training epochs and large-error behavior. A new epoch is not an independent
session or hardware profile. Disclose individual severe errors that an aggregate
percentile can hide. Preserve the frozen candidate and its adverse results;
any revised hypothesis begins a new study with new future evidence. Once a test
cohort informs model or policy selection, it is no longer untouched validation
for that revised candidate.

These prefill features become available at engine start, after cache selection.
Even a successful gap-filling experiment would initially support an updated
component forecast, not an admission-time cache-path choice. Live activation,
end-to-end calibration and routing benefit remain separate gates; no such hybrid
is enabled by this protocol.

### Separate rate-normalized follow-up

A new private hypothesis learns a correction to a causal per-token estimate
rather than directly predicting elapsed time. Its anchor uses at least three
prior positive-new-token observations from the same process epoch and cold/suffix
regime, within the existing history bounds. Sparse history and zero-new-token
queries abstain for this candidate; a finite existing baseline still wins.
Compare the learned correction with that exact simple anchor on identical added
opportunities, not with an absent baseline or a different coverage partition.

Previously inspected captures are development/training for this new hypothesis,
not untouched validation. Freeze an exact evaluation boundary only after model,
feature, evaluator, scorer and policy bytes exist; a rounded model timestamp can
otherwise admit requests observed before freezing finished. Verify all pinned
hashes before later scoring and preserve baseline parity during row extraction.

The first later check is a small suffix-only cohort. It supplies bounded evidence
but cannot address the severe development tail, cold regimes or new process
epochs. Keep those missing partitions explicit; do not let favorable early error
averages substitute for them. No candidate, fallback or routing change is enabled.

## Privacy-safe snapshot inventory

**Implemented as an opt-in local/mounted-directory foundation; it does not route
or transfer caches.** Stock DS4 `<40-hex>.kv` disk-KV files begin with a 48-byte compatibility
header and four-byte rendered-text length. Verbatim prompt bytes follow. DSG opens
only regular 40-hex cache files with no-follow semantics and reads exactly those
first 52 bytes. It validates magic/version/payload ABI, quantization, token count,
file bounds and numerical metadata before accepting an entry.

The filename is a SHA-1 of a rendered prompt prefix and is therefore sensitive to
dictionary guessing. DSG never exports it. A private installation key converts it
to an HMAC pseudonym that is comparable across explicitly inventoried directories
inside one DSG installation but useless to another installation. Local
diagnostics expose only aggregate cohort count, byte and maximum-token summaries;
paths, raw names, pseudonymous snapshot references and prompt bytes remain absent.

Compatibility follows DS4's conservative header gates: model shape, target
context capacity, quantization policy and same-quant weights fingerprint. A legacy
zero weights fingerprint is **unknown**, never compatible. Header agreement is
still bounded evidence: it does not prove a cache is currently resident, that a
request matches the byte prefix, or that a remote transfer/import path is safe.

Configure only a directory already readable on the dashboard host. The scanner
accepts the exact stock `<40-hex>.kv` filename shape; unrelated files are ignored:

```json
"cache_directories": { "worker-a": "/srv/ds4/cache" }
```

Scans run no more than once per minute and examine at most 4,096 cache-shaped
files. Missing, symlinked, unreadable, oversized or invalid inputs abstain. The
scanner performs no inference and no writes to the DS4 directory. The next stage
now has a pure [four-path shadow comparator](cache-continuity-shadow.md). It
compares wait-hot, local-restore, remote-acquisition and cold-prefill critical
paths while preserving unknown evidence. It is not yet fed from live requests;
no remote command, copy protocol or automatic routing is claimed.

A separate [cache-continuity audit](cache-continuity-audit.md) measures realized
same-session reuse from the private numerical dataset. Its aggregate ratios help
find evidence gaps and anomalous low reuse, but do not prove snapshot presence or
supply an unchosen path's acquisition cost.
