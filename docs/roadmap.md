# Feature roadmap

This is a living roadmap, not a claim that every feature below ships today.
DSG remains a companion to [antirez's DS4 engine](https://github.com/antirez/ds4).
The engine performs inference and manages KV state; DSG observes and routes.

## Prioritized delivery order — reviewed 2026-09-02

This table is the current order; the sections below retain the detailed design.
See the [maintenance review](maintenance-review-2026-09-02.md) for reproduced bugs,
fixes and remaining uncertainty. A source commit is not a live deployment receipt.

**Recovery update:** order 6's first slice is now implemented in
[bounded DS4 service recovery](worker-recovery.md): systemd-user enrollment, GG and
detector requests, independent guards, durable receipts and cold/warm verification.
This does not fix the CUDA defect or implement launchd/container recovery. The
next reliability/data priority is request-to-engine attribution with backend
process epochs, followed by the embedding collection slice already specified below.

**Live deployment checkpoint:** the [two-Spark canary record](recovery-canary-2026-09-03.md)
documents the maintainer's completed cutover, real cache checks and explicit
automatic-recovery opt-in. That deployment receipt does not enable recovery on
another installation or promote any of the prediction/embedding work below.

| Order | Work | Exit evidence |
| --- | --- | --- |
| 0 | Promote protocol/quarantine maintenance fixes through a controlled cutover | Regression suites pass; versioned backup; real API-format smoke checks; unchanged fleet/context; explicit source-versus-running release record |
| 1 | Diagnose the Spark CUDA/OOM incidents and identify backend process epochs | Correlated service/kernel/memory evidence and targeted reproduction; real cold/warm checks plus representative sustained work; no unapproved context/cache reductions |
| 2 | Explain idle capacity and design cache-aware overflow scheduling | UI identifies session-home waits; replay/shadow comparisons of wait-at-home versus cold execution elsewhere; prove no overlapping ownership/replay; operator-approved policy before activation |
| 3 | Data quality and local embedding collection, with a visible collection panel | Versioned encoder and bounded text extraction; current-request feature-availability timestamps; failure/backpressure/privacy tests; joined vectors and valid labels across hardware |
| 4 | Refit the offline XGB experiment, then shadow ETA predictions | New immutable artifact versus baseline; hardware/context/session coverage; production tree count selected by time/session-aware CV before promotion |
| 5 | Persistent Genie/operator activity and endpoint settings UI | Durable actor/channel/action receipts, stale-evidence labels, feedback, endpoint test/save/rollback; manual controls remain authoritative |
| 6 (first slice implemented) | Opt-in deterministic recovery runner and Genie access | Systemd-user only; see recovery guide for tested scope and deployment gates |

Orders 2 and 3 can be built alongside reliability diagnosis, without changing live
routing. Do not wait for an LLM or trained predictor merely to explain why a queue
is pinned. Recovery remains bounded to one attempt per failed instance with a
30-minute per-worker cooldown; unexplained recurrence requires investigation,
not an unbounded restart loop.

**Current scheduling limitation:** healthy session homes remain sticky even when
their queue grows and another server is idle. Waiting counts are per-worker queues,
not a globally stealable queue. Recovery/restart can reassign a home; when the old
server returns, the session does not automatically move back. This preserves cache
locality but does not prove minimum completion time. A future overflow policy must
consider queued as well as active work and establish a safe per-session handover
before changing affinity. Cache copying is not required for a first shadow policy.

**Maintenance decisions:** the README explicitly has no open-source license grant;
add license text only if the maintainer chooses it. Keep public screenshots synthetic
and clearly distinguish earlier illustrative captures from new collection/Genie UI.

## First slice: evidence and an observation-only Gate Genie

**Queued-work shadow now implemented, opt-in:** [setup and limits](routing-shadow.md).
It records per-worker/session clocks and compares an unvalidated historical
baseline without moving work. This is not the planned calibrated, cache-aware XGB
router. Dedicated UI explanations, verified cache/process evidence and production
handover are still outstanding. Embeddings remain unimplemented, not implied by
the new timing features. "Remaining busy time" comes before demand forecasting of
how long an idle machine will remain unused.

- **Passive routing dataset:** opt-in private numerical records of fleet load at
  admission, placement, queue/service durations, reported token usage and failures.
  No raw conversations, answers, tool arguments or embeddings in this first slice.
- **Fleet activity:** serving-slot occupancy and immediately free slots, plus
  sampled idle/prefill/thinking/answering timelines. Prefill and decode use separate
  scales shared across servers. Serving slots are not GPU utilization or hot KV slots.
- **Gate Genie:** an optional local LLM observer with dashboard chat. It receives
  a compact metrics briefing, not user conversations. With separately enrolled
  services and automatic recovery enabled, it can request the independently
  guarded recovery action described above. It has no shell, arbitrary routing,
  model-setting or cache-editing tools.
- **Portable observer inference:** a dedicated compatible server is preferred;
  an explicit dashboard selector can use the DSG pool as fallback. No silent
  failover or requirement for a particular machine. Shared-pool reviews consume
  ordinary inference capacity and must be interpreted as observer traffic.

See [collection and Genie setup](observer.md) for the implemented boundaries and
configuration. Opt-in capabilities remain off unless configured/enabled.

## Immediate next delivery decisions — 2026-09-02

**First XGB fit = a plumbing smoke test.** Cross-validation is not a prerequisite
for this first artifact; fit/save/reload, schema consistency and no leakage are.
Its existing tiny chronological holdout is diagnostic only. Before any production
XGB predictor is promoted, cross-validate **tree count** (`n_estimators` /
`num_boost_round`, often called `ntrees`) within training data, using forward-time
folds with session-group separation and purged unavailable labels. If using early
stopping, use each fold's validation subset, not the final test set. Select the
tree count from those folds, refit on training data, and assess once on a separate
untouched later-session test set. Record folds, candidate counts, selection rule,
baseline and chosen count. Too little data means no validated production model,
not random row CV or invented examples. This is a later release gate, not tonight's
smoke-test gate; the current fixed 32-round experiment remains unchanged.

**Embeddings are the next collection slice, not something to wait for a mature
predictor to begin.** Planned implementation, not enabled yet:

- Pin a small local encoder, revision, tokenizer, dimensions and extraction
  policy. Do not assume DS4's chat endpoint supplies embeddings. Encoder choice
  and measured host overhead are still to be verified before installation.
- Embed two separately labelled inputs: the latest user text and a bounded slice
  of preceding user/assistant-visible conversation. Exclude system/developer
  instructions, hidden reasoning, tool arguments/results and image payloads in
  the first version; document the resulting blind spots for tool-heavy workloads.
  Apply explicit encoder-token and parser-memory bounds, with truncation flags.
- Copy only the bounded text needed into a local, asynchronous work queue; never
  await embeddings on the inference path or spool raw text to disk. Persist
  vectors, request/run ID, encoder/schema version, token counts, missing/error
  status and extraction/ready timestamps. Numeric collection continues on encoder
  failure, queue overflow or disabled embeddings. No cloud calls or silent model
  substitution; vectors remain sensitive private data.
- Preserve request forwarding byte-for-byte. Instrument API formats explicitly;
  unsupported or oversized bodies become missing-feature records, not broken
  inference or silent truncation of the actual prompt. Test streaming upload,
  backpressure, disconnects, malformed payloads and encoder failure/timeout.
- The gateway currently places a request before reading its body. An embedding
  generated after placement is usable for workload research, **not retroactively
  available to that routing decision**. Collection comes first; future shadow/live
  scheduling must define its prediction point and match feature availability in
  training and serving. Exclude future answer text from every embedding input.
- Refit a basic metadata-plus-embedding smoke model once joined labels exist;
  compare against metadata-only later. Historical numerical rows stay without
  embeddings because their raw conversations were not retained.

**Gate Genie UI: evidence, commentary and actions must be distinct.** Assessments
remain in-memory; the separate recovery panel now shows durable executor receipts.
Broader persistent conversation/feedback and endpoint controls remain next additions:

1. Persistent chronological activity: observation, proposal, started, applied,
   verified, failed, rejected and undone. Each entry names time, actor, target,
   reason, evidence references and actual before/after state. Model prose is
   commentary; only executor receipts and fresh checks establish action success.
2. A clear mode/source strip: off, observing or authorized actions; dedicated
   endpoint versus pool fallback; reviewing/busy/error and last fresh evidence.
   Retain manual controls and show the exact permitted actions, not a blanket
   implication that the Genie can already restart or migrate jobs.
3. A worker alert badge with the fault and an evidence drawer. Distinguish API
   reachability from generation health. A model-list response must not clear a
   fatal execution quarantine; reinstate through explicit verified recovery.
4. A durable question/answer thread plus per-assessment feedback (useful, wrong,
   resolved, with optional note). Feedback attaches to its evidence/action ID and
   remains separate from measured training labels; it is not an automatic edit
   to the predictor or a machine's health state.
5. Collection/training progress: eligible completed rows, coverage by hardware,
   embeddings enabled/ready/pending/missing/failed, encoder version/latency and
   latest fit/result. Clearly say **experimental/offline**, not "learning router"
   while predictions are disconnected. Keep prompts and vectors out of public
   diagnostic downloads and screenshots.

**Implemented separately:** [generation-failure quarantine](generation-health.md)
does not depend on embeddings, XGB training or the Genie LLM. Its tests cover an
API that still answers model-list probes while inference fails, repeated failures,
existing session affinity, queued-but-undispatched rejection without replay and
verified reinstatement. Bounded systemd-user service recovery now ships separately;
transparent client recovery remains unimplemented. Already running streams are
never blindly replayed.

## Next: cache health, not just cache counters

Distinguish expected cold starts, useful prefix reuse, disk restores and
potentially avoidable misses. Add bounded keyed prefix fingerprints and reliable
request-to-engine attribution before accusing a specific route of wasting cache.
Similarity alone does not prove KV compatibility; a RAM miss may be a disk hit.
Reports must show evidence, uncertainty and concrete checks. No automatic prompt
rewrites, unrelated-session merging, or speculative cache deletion.

## Then: measured ETA prediction with XGBoost

**First offline slice is implemented:** an optional [XGBoost training package](../predictor/README.md)
fits real numerical evidence, separates machine identity from hardware class/RAM,
performs chronological/session-disjoint evaluation and saves a checksummed model
with its preprocessing and report. It has **no live routing or promotion path**.
This establishes the training plumbing; a tiny first fit is not calibration.

Optimize **expected completion time**, including waiting, cache restoration,
prefill and generation—not raw tokens/second alone.

1. Collect ordinary workload evidence, marking missing, cancelled and truncated
   results. Record only the chosen server's actual result; other servers' outcomes
   are unknown, not invented training labels.
2. Add small, bounded idle-time calibration jobs for new devices. Real jobs take
   priority; no large-context benchmark campaign by default.
3. Establish a simple measured baseline, then a narrowly scoped XGBoost predictor.
   Evaluate on later sessions held out from training. Prediction uncertainty and
   unfamiliar configurations must be visible.
4. Compare metadata-only prediction against optional **locally generated
   embeddings** of a bounded recent-conversation slice plus the latest user turn.
   Choose and pin an encoder, preprocessing, dimensions and truncation policy.
   Never silently send conversation text to a cloud embedding API.
5. Shadow routing first. Deploy only after measured validation, with a fixed,
   immutable compatible fallback model and deterministic routing fallback.

No embedding encoder or live XGBoost predictor is installed by the current observer.
Because raw text is not retained, old numerical records cannot later acquire
embeddings. Embedding-enabled collection begins a new, versioned dataset slice.
Derived vectors are sensitive too and stay in private local storage.

## Later: the Genie can operate tested switches

The [Genie powers plan](genie-powers-plan.md) specifies the CUDA recovery scenario,
the separation of Genie/XGB/scheduler/executor, narrow action permissions, UI
controls, tests and shadow-to-canary deployment. Systemd-user recovery is the
implemented subset; the broader powers and editable endpoint controls remain
proposed. Installation-specific enrollment, canary evidence and explicit opt-in
are still required before automatic recovery is enabled.

- Quarantine a demonstrably faulty server for **new conversations**, without
  disrupting admitted work; reinstate after evidence-backed recovery.
- Run bounded XGBoost tuning/evaluation jobs and promote passing models through
  independent gates; show exactly what changed, why and when.
- Recover confirmed stuck requests while the client continues automatically.
  Mid-stream replacement needs client cooperation and tool-state reconciliation;
  appending a different answer to an existing stream is not transparent recovery.
- Keep manual controls authoritative and model inference independent of the Genie.
  His failure must never prevent ordinary routing.
- Improve operator-control audit records: show when a pause/resume was applied,
  the authenticated actor/channel where available, and a supplied reason. Current
  worker-drain events record time and targets, not who requested the change or why.
  Do not infer intent or blame from a paused flag alone.

A frozen Pi adapter is a later packaging option. The first observer is a small
OpenAI-compatible client, not an embedded Pi/Hermes bot with shell access.

## Adding or removing devices

Use stable categorical worker identities plus shared hardware-class features and
configuration-labelled evidence, not machine-name-only predictions. New machines start with limited confidence,
compatibility checks and small calibration. Removed machines stop being routing
candidates; their measurements need not be erased. Never lower the pool context
guarantee just to admit an incompatible worker. The dedicated Genie endpoint is
not itself required to match the worker pool's context size.

## Moonshot next idea: cache-aware session relocation

Could the Genie move a conversation from a congested server to an idle compatible
server, carrying its disk KV cache instead of paying for a full cold prefill?
Worth investigating, **not implemented, and cross-device cache portability is
not yet verified**. Matching API model names alone do not establish compatibility.

### Agreed direction: compare four paths to completion

**Planning decision — 2026-09-02:** long-context prefill is expensive on this
fleet. A disk or remotely fetched checkpoint may be much cheaper than repeating
it. A hot cache is a useful advantage, not an absolute routing rule. Choose the
lowest expected completion time among feasible **server + cache-source** pairs:

1. **Wait for the hot server:** its queue/residual work + new-suffix prefill +
   generation. Waiting can outweigh the benefit of RAM residency.
2. **Restore a local snapshot:** destination wait + local read/restore + uncached
   suffix prefill + generation.
3. **Fetch a remote snapshot:** destination wait and transfer/export scheduling +
   integrity checks + destination restore + uncached suffix prefill + generation.
4. **Prefill cold:** destination wait + full prefill + generation. This remains a
   legitimate fallback when no compatible useful checkpoint exists.

Model the critical path: transfer may overlap waiting, so do not blindly add
durations that run in parallel. Include donor/export stalls, network contention,
destination memory pressure and displacement of another valuable hot session.
An older nearby checkpoint plus a small suffix can beat fetching the newest,
largest remote checkpoint. No route is automatically best because it is "hot,"
"local," "fast hardware" or "the latest checkpoint."

**Proposed storage shape:** keep fast per-server local cache storage and give DSG
a fleet-wide catalog of compatible snapshots. Fetch or selectively replicate a
completed immutable snapshot to the destination's local storage when measured
savings justify it. The catalog can be centralized without making one central
disk or the M2 a mandatory bulk-data bottleneck. Do not mirror every update to
every server by default. No shared mutable cache directory is being enabled.

The source review supports investigation, not a portability claim:
[Antirez's cache-format documentation](https://github.com/antirez/ds4/blob/main/README.md)
describes persistent session/token/tensor state and limits portability to
compatible engine builds/model layouts. The inspected cache manager also updates
file headers, replaces entries and evicts files. A common writable network folder
would need explicit multi-process ownership, atomic publication and eviction
coordination; a common mount alone does not supply those properties.

Record for the evaluator: checkpoint identity/version, exact compatible model
cohort, cached-prefix token count, bytes, source/replica locations, evidence age,
export/transfer/restore timings, network throughput under load, suffix-prefill
cost, actual destination reused-token count and final latency. Snapshot identity
must cover model weights, format/layout, exact token history and required
tool/vision state. Embedding similarity may inform cost estimation, but must
**never authorize KV reuse**. Keep whole checkpoints private: they can contain
verbatim conversation text, not merely the anonymous-looking session hash.

First experiment: a completed checkpoint restored between compatible Sparks,
then a separately certified Spark/Mac pair. Prove correct continuation and a real
warm-prefix hit versus cold execution; measure end-to-end savings at representative
context lengths. Resolve the current accelerator-checkpoint/OOM failures before
trusting a wider restore/replication path. A checkpoint failure alone does not
prove the stored file is corrupt. No cache deletion, format conversion, replication
daemon or automatic migration is authorized merely by this planning note.

Start with **between-turn migration**, not a running decode or process migration:

1. Respect operator eligibility: a paused, drained or quarantined target is not
   spare capacity. Check target context, memory/cache headroom and competing work.
2. Prove cache compatibility across engine/cache format versions, model weights
   and quantization, tokenizer/template, vision state, and CPU/GPU backends. A
   Spark-to-Mac transfer needs its own restore test; do not assume it from two
   successful independent cold runs or from a matching filename.
3. Obtain a completed, immutable session snapshot through a supported export or
   verified safe disk mechanism. Prevent new source work during handover. Never
   copy a mutable file out from under an active generation.
4. Compare expected completion times: source queue + warm execution versus
   transfer + verification + destination restore + execution + cache eviction
   cost. Require a meaningful margin under uncertainty and avoid repeated moves.
5. Transfer privately over authenticated transport, verify integrity and restore
   into isolated destination state. KV files contain sensitive conversation state;
   never put them in public diagnostics or datasets.
6. Prove real prefix reuse at the destination and atomically hand over affinity
   with an ownership/generation check. Do not let a racing next turn split the
   conversation across machines. Keep the source copy until handover is confirmed;
   failure retains a safe source route or rolls back, without deleting the cache.

Acceptance: correct continuation and actual cache-hit evidence across each
supported hardware pair; interrupted transfer, incompatible cache, full target,
new turn during migration, and failed commit/rollback tests. If compatibility is
not possible, ordinary cold re-prefill remains an explicit costed alternative,
not a disguised cache transfer. The Genie could propose a move; an independently
validated deterministic mechanism would enforce the handover.

## How this roadmap grows

Keep proposed, implemented, experimentally validated and enabled capabilities
distinct. Add tests and evidence alongside features, keep operator deployments and
training data out of this public repo, and prefer small reversible releases.
