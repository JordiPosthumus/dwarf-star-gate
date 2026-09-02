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

Use stable worker identities and configuration-labelled evidence, not one model
feature column per named machine. New machines start with limited confidence,
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
