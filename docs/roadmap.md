# Feature roadmap

This is a living roadmap, not a claim that every feature below ships today.
DSG remains a companion to [antirez's DS4 engine](https://github.com/antirez/ds4).
The engine performs inference and manages KV state; DSG observes and routes.

## First slice: evidence and an observation-only Gate Genie

- **Passive routing dataset:** opt-in private numerical records of fleet load at
  admission, placement, queue/service durations, reported token usage and failures.
  No raw conversations, answers, tool arguments or embeddings in this first slice.
- **Fleet activity:** serving-slot occupancy and immediately free slots, plus
  sampled idle/prefill/thinking/answering timelines. Prefill and decode use separate
  scales shared across servers. Serving slots are not GPU utilization or hot KV slots.
- **Gate Genie:** an optional, local, read-only LLM observer with dashboard chat.
  It receives a compact metrics briefing, not user conversations. It can explain
  evidence but has no tools that modify workers, routing, model settings or caches.
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

**Gate Genie UI: evidence, commentary and actions must be distinct.** The current
read-only panel is not an action executor or a durable conversation history.
Next additions should be:

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
verified reinstatement. Automatic service restart and transparent client recovery
remain unimplemented; already running streams are never blindly replayed.

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
