# Feature roadmap

This is a living roadmap, not a claim that every feature below ships today.
DSG remains a companion to [antirez's DS4 engine](https://github.com/antirez/ds4).
The engine performs inference and manages KV state; DSG observes and routes.
The [DS4 integration contract](ds4-integration.md) is explicit: learn the engine's
existing interfaces deeply; do not edit DS4 or require a custom server build.

## Delivery principles

Our guiding light is **a low-effort DS4 fleet that keeps agents working.
Intelligence should make that dependable foundation better—not become another
dependency that can stall it.**

- Core scheduling, maintenance isolation and certified retry safeguards must not
  depend on a successful Genie review. Respect reservations and session ownership.
- Prove deterministic balancing first. Keep learning and shadow comparisons;
  predictors earn routing authority through the existing validation gates and
  measured operational benefit, not prediction accuracy alone.
- Client continuity is a client–gateway contract. Friendly guidance alone does
  not guarantee another agent turn; ambiguous dispatched work must not be replayed.
- Judge progress by waiting time, useful completions, avoidable idle capacity,
  recovery time and sessions requiring human rescue. Idle maintenance or protected
  work is not automatically wasted capacity.
- Deliver staged, reviewable milestones. Distinguish implemented, tested, live
  and demonstrably helpful. Genie uses enrolled recovery procedures and proposes
  development improvements; outages do not authorize improvised infrastructure edits.

These principles set priorities; they do not claim all guarantees are implemented,
disable existing validated capabilities, or relax activation and maintenance gates.

## Prioritized delivery order — reviewed 2026-09-03

This table is the current order; the sections below retain the detailed design.
See the [maintenance review](maintenance-review-2026-09-02.md) for reproduced bugs,
fixes and remaining uncertainty. A source commit is not a live deployment receipt.

**Continuity update:** [patient gateway waiting](client-continuity.md) now covers
undispatched worker outages with original deadlines, FIFO conversation ownership,
live wait evidence and no replay. The [Continuity Door](continuity-door.md) now
keeps the client endpoint stable across a coordinated DSG core replacement while
preserving unread bodies and existing streams. Native Pi transport is covered by
an opt-in real-library/fake-backend acceptance test. Arbitrary post-dispatch
gateway/engine loss remains separate work; a green fleet does not resume an
already stopped Pi turn. All DSG-owned API errors identify themselves.

**Analytics implemented:** the compact [prediction-accuracy panel](analytics.md)
joins existing admission-time shadow forecasts to observed queue/server durations,
with per-server filters, missing-prediction coverage and error. This is an
unvalidated historical baseline. Separate [versioned V2/V3 live XGB forecasts](predictor-lifecycle.md)
and lifecycle controls are now implemented, off by default. V2 incumbents remain
byte-compatible while V3 challengers add causal admission/cache clocks, early
client counters and bounded request shape under independent validation. The model plan prioritizes total
service time and remaining busy time; queue wait is derived, not idle-demand
forecasting. Optional [local embedding/progress collection](embeddings.md) and the
[measured cache-cost calculator](cache-cost.md) are now implemented. Privacy-safe
backend epochs and conservative request/engine candidates are implemented below;
exact protocol attribution and proving learned prediction accuracy remain work.
The pure [four-path cache-continuity comparator](cache-continuity-shadow.md) is
also implemented with fail-closed presence/compatibility gates and no scheduler
authority. Live rendered-prefix identity, a validated remote transfer/import
protocol and future component validation remain prerequisites for live shadows.
The first [privacy-safe cache-continuity audit](cache-continuity-audit.md) now
measures consecutive same-session reuse from existing numerical evidence and
abstains on relocation, compaction, profile/epoch change, stale or censored work.
It separates strongly guarded suspicion from unconfirmed low reuse and has no
cache or routing authority.

**Recovery update:** order 6's first slice is now implemented in
[bounded DS4 service recovery](worker-recovery.md): systemd-user enrollment, GG and
detector requests, independent guards, durable receipts and cold/warm verification.
Sanitized management-path evidence now distinguishes DS4 readiness from DNS,
SSH identity/authentication, connection and recovery-helper failures. This makes
operator and Genie advice specific without turning a network symptom into restart
authority or exposing private transport details.
Remote workers can also carry a bounded ordered set of verified OpenSSH aliases;
the tunnel and guarded recovery adapter share it. This improves route resilience
without granting arbitrary SSH arguments, commands or host-reboot authority.
This does not fix the CUDA defect or implement container recovery. The separately
enrolled launchd adapter is source-complete and synthetically tested, but remains
ineligible on each Mac until that installation passes its own private drained
canary. An explicitly enrolled same-host transport is now implemented without
shell access or an SSH requirement; the launchd action still requires a loaded
job. Explicitly enrolled bootstrap of an OS-removed job remains separate work;
a removed transient registration is not a stopped-job restart. Preserve operator
stop intent and validate a real removed-job canary before enabling that broader
recovery. The
backend-process-epoch foundation is now implemented for strong systemd journal
telemetry and bounded same-host stock DS4 listen markers: observed restart
boundaries invalidate telemetry spans without changing DS4. The bounded
[request-to-engine correlator](request-attribution.md) is also now
implemented in shadow: it corroborates a candidate only when the process epoch,
unique gateway window and returned usage agree, and abstains on direct or
ambiguous evidence. A privacy-bounded read-only attribution-yield audit now
deduplicates final revisions, measures resolved corroboration by server and names
the fixed abstention causes without exposing request identities or text. Repeated
ordinary-traffic review across process epochs is the next reliability/data gate.
The separate embedding slice now collects future
workload features without waiting for improved stock-interface attribution or
changing routing.

Use the [recovery validation procedure](recovery-validation.md) before enabling
an enrolled service. Deployment receipts and policy activation belong in private
operator records, not this public roadmap.

**Agent coordination implemented:** [scoped agent access](agent-api.md) adds
per-principal worker grants, status, owned drain holds, checked release and durable
idempotency receipts to the existing private executor. Manual pauses and other
agents' holds win. UI ownership labels prevent unexplained Enable/Remove actions;
no extra service, model-server edit or automatic Genie authority is introduced.
Source is tested independently of deployment; grants require the new gateway
code to be activated. A thin MCP wrapper and remote agent transport remain future
work. The [Genie notebook](genie-memory.md) now implements opt-in persistence of
worker changes, incident/recovery references and explicit operator notes. Full
chat persistence, generated hypotheses and notebook search remain planned. Bounded
training recipes, early metadata collection and skip-only calibration preflight
are implemented separately.

| Order | Work | Exit evidence |
| --- | --- | --- |
| Immediate | [Client continuity](client-continuity.md): distinguish undispatched waits from interrupted generation, scope home ownership correctly, and avoid abandoning Pi turns | Patient waiting, receipts, Continuity Door, conversation-scoped admission reassignment and opt-in Pi transport implemented; real Pi agent/tool-loop fixture covers native waiting and certified retries. Arbitrary post-dispatch recovery remains separate work |
| Immediate follow-up (planned) | Opt-in **Agent Watch** for Pi/Hermes runs that stall before submitting their next DSG request | Privacy-safe client heartbeat distinguishes local tool work, client-side admission wait and a genuinely stale run; Genie reports the diagnosis first. Any future nudge/revive adapter is separately enrolled, idempotent and receipt-backed; DSG never guesses from silence alone |
| 0 | Promote protocol/quarantine maintenance fixes through a controlled cutover | Regression suites pass; versioned backup; real API-format smoke checks; unchanged fleet/context; explicit source-versus-running release record |
| 1 (shadow attribution + audits implemented) | Diagnose the Spark CUDA/OOM incidents and correlate requests within backend process epochs | Privacy-safe strong systemd epochs and file-ordered bounded local-log epochs plus a fail-closed request/log candidate correlator, long-overlap candidate retention, immutable recorded audit and complete-source later-evidence view are implemented; next evidence is fresh post-fix Mac traffic, review of the remaining true overlaps across real process epochs, service/kernel/memory diagnosis, real cold/warm checks and representative sustained work; no unapproved context/cache reductions |
| 2 (pure comparator implemented) | Explain idle capacity and design cache-aware overflow scheduling | UI identifies session-home waits; the offline wait-hot/local-restore/remote-acquisition/cold-prefill contract is tested and abstains on unknowns; next prove live identity, remote protocol, realized forecast accuracy and no overlapping ownership/replay before any operator-approved activation |
| 3 (collector implemented) | Validate local embeddings/progress on ordinary workload | Pinned CPU encoder, bounded extraction and visible status; collect joined future labels across hardware; exact cache/engine attribution still separate |
| 4 (V2/V3 lifecycle implemented) | Collect future validation evidence for versioned forecasts | Fixed forward-time tree/feature selection, separate unseen-session placement gate, per-worker future evidence and parallel V2/V3 evaluation; no experimental model controls routing |
| 5 (notebook first slice implemented) | Persistent Genie/operator activity and endpoint settings UI | Private notebook storage, revisioned notes and bounded historical retrieval tested; generated hypotheses, full chat persistence and endpoint test/save/rollback remain planned |
| 6 (bounded runner implemented) | Opt-in deterministic recovery runner and Genie access | Systemd-user canary complete; a separately enrolled launchd adapter is synthetically tested and still requires a private per-Mac canary. Exact fatal-instance restart plus separately enrolled stopped-service start; see recovery guide for deployment gates |
| 6a (implemented in source) | Verified changed-profile hand-back | Default-on sub-policy under opt-in automatic recovery; separated identical inspections, same enrolled machine/service, no admitted work, fatal-or-new-invocation proof, private durable adoption, model/context + generation + two cold-to-warm verification. Pauses, maintenance locks and agent holds win; no arbitrary command or submitted fingerprint |
| 6b (implemented in source) | [Named durable maintenance locks](maintenance-locks.md) | Visible name/reason/advisory review policy, exact idempotent release, persistent receipts, and a hard veto on broad Resume, agent release, recovery and hand-back. Review deadlines warn but never auto-expire; releasing leaves a pause for a separate checked Resume. Same-user operator attribution remains an explicit boundary |

Orders 2 and 3 can be built alongside reliability diagnosis, without changing live
routing. Do not wait for an LLM or trained predictor merely to explain why a queue
is pinned. Recovery remains bounded to one attempt per failed instance or stopped
epoch with a 30-minute per-worker cooldown; unexplained recurrence requires investigation,
not an unbounded restart loop.

**Current scheduling boundary:** [safe queued handover](queued-handover.md) is now
implemented. A first DSG request or unaffined queue head automatically takes a
newly free healthy server while it is still undispatched. Existing session homes
receive a conservative five-minute first-refusal window; afterward the core can
move the oldest safe queue head to a completely idle server even if the dashboard
or Genie is absent. Before that boundary, the operator or Gate Genie can request
one exact offer; a
deterministic executor rechecks current ownership, destination availability and
evidence before moving the still-undispatched client stream. Waiting counts remain
per-worker queues, not a globally stealable queue. Broader automatic overflow must
first prove that predicted waiting saved exceeds cache-acquisition cost with
adequate margin and hysteresis.

**Scheduling explainability implemented:** bounded relocation diagnostics now
name why each live queue head is offered, waiting for the Genie threshold, kept at
home by same-session ownership, or blocked by destination/readiness state. These
reason codes are status evidence for the operator and Genie, not new routing
authority. A validated-evidence-only remaining-time tie-break now applies only to
new/unaffined requests tied on deterministic active-plus-queued load. It abstains
if any tied candidate lacks fresh deployed evidence and never overrides a freer
worker or established session home. Receipts distinguish proposed from applied;
next evaluate realized queue outcomes before widening its scope.

**Maintenance decisions:** the README explicitly has no open-source license grant;
add license text only if the maintainer chooses it. Keep public screenshots synthetic
and use the [current reproducible demo](screenshots.md), including collection/Genie UI.

## Implemented foundation: evidence and bounded Gate Genie actions

**Queued-work evidence now implemented, opt-in:** [setup and limits](routing-shadow.md).
The original historical shadow still records per-worker/session clocks without
moving work, and it remains an unvalidated baseline rather than a cache-aware
router. Bounded UI explanations, backend process epochs, request-correlation
candidates, optional embeddings, versioned XGB forecasts and exact safe
pre-dispatch handover now ship as separate layers. The deterministic handover
policy and validated-evidence-only tie-break are described above; neither turns
an experimental shadow estimate into routing authority. Remaining work is to
measure realized outcomes, improve cache-acquisition attribution and let the
existing promotion gates decide whether a learned cost model earns any broader
scope. Embeddings remain a separate opt-in collector. "Remaining busy time"
comes before forecasting how long an idle machine will remain unused.

- **Passive routing dataset:** opt-in private numerical records of fleet load at
  admission, placement, queue/service durations, reported token usage and failures.
  No raw conversations, answers or tool arguments. Separately enabled embedding
  collection adds sensitive derived vectors, never source-text retention.
- **Fleet activity:** serving-slot occupancy and immediately free slots, plus
  sampled idle/prefill/thinking/answering timelines. Prefill and decode use separate
  scales shared across servers. Serving slots are not GPU utilization or hot KV slots.
- **Gate Genie:** a local LLM observer with dashboard chat, on by default unless
  explicitly disabled. It receives
  a compact metrics briefing, not user conversations. With separately enrolled
  services and automatic recovery enabled, it can request the independently
  guarded recovery action described above. It can report a mature
  queued-handover offer and may request exactly that offer. The independent
  executor revalidates it. It has no shell, arbitrary routing, model-setting or
  cache-editing tools. A dedicated endpoint automatically gains bounded pool
  fallback; without one, Genie uses one ordinary unpinned pool slot.
- **Portable observer inference:** a dedicated compatible server is preferred;
  after an explicit dedicated-provider failure, Genie automatically borrows one
  unpinned DSG pool slot. The pool receives the bounded live briefing but not the
  private notebook. An explicit dashboard selector can also use the pool directly.
  Shared-pool reviews consume ordinary inference capacity and are marked observer traffic.

See [collection and Genie setup](observer.md) for the implemented boundaries and
configuration. Opt-in capabilities remain off unless configured/enabled.

## Historical first-fit decisions — 2026-09-02

The following paragraph records the v1 smoke-test agreement, not the current
promotion path. The current V2/V3 lifecycle cross-validates tree count and feature
families with forward-time, label-purged folds; it additionally tests unseen
sessions before new-session placement. The
[lifecycle contract](predictor-lifecycle.md) is authoritative.

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
not random row CV or invented examples. The original fixed 32-round smoke mode
remains available; `--cross-validate-trees` now performs the bounded inner
selection. Neither creates routing authority, even if a candidate beats baseline.

**Embedding collection is implemented, off by default**, independently of any
mature predictor. See [the exact extraction/setup contract](embeddings.md).

- Pin a small local encoder, revision, tokenizer, dimensions and extraction
  policy. The first encoder is CPU ONNX all-MiniLM-L6-v2, pinned to an immutable
  revision, 384 dimensions and 256 tokens per slice. DS4's chat endpoint is not
  used for embeddings. Verify host overhead before each deployment.
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

**Implemented foundation:** an opt-in local/mounted-directory inventory reads
only stock DS4's 52-byte disk-KV header, replaces prompt-derived filenames with
installation-keyed HMACs, reports aggregate compatibility cohorts and abstains on
legacy unknown weights. It does not expose snapshot references, read prompt bytes,
copy caches or change routing. Next: explicitly enrolled remote inventory and the
four-path shadow comparison using measured critical-path components.

**Implemented audit slice:** a bounded read-only dataset audit measures reuse on
consecutive same-session/same-worker completions. It reports aggregate ratios and
fixed abstention reasons, never IDs or text. Strong suspicion additionally needs
an unchanged observation epoch plus consecutive client turn and compaction
evidence; without those, low reuse remains unconfirmed. Exact rendered-prefix
identity and a remote cache protocol remain separate prerequisites.

## Then: measured ETA prediction with XGBoost

**The versioned V2/V3 lifecycle is implemented:** [forecasts and bounded model stewardship](predictor-lifecycle.md)
use causal request history, missing-data/peer priors, optional embedding updates,
phase/elapsed remaining estimates and frozen artifacts. GG can request training
or offered rollback; fixed validators decide promotion. New-session placement is
separately armed and requires unseen-session evidence. Existing queues/sessions
are not moved. The [historical v1 experiment](../predictor/README.md) is preserved.

**Next model work, in order:**

The [read-only data audit](data-quality.md) and bounded non-streaming OpenAI JSON
usage collector now ship. They improve evidence/coverage; they do not promote a
predictor or change routing. Historical missing usage remains missing.

1. Audit accuracy and coverage separately by stage, hardware, context size and
   long-running work. Keep the strongest causal baseline when XGB loses. Improve
   timestamped prior-turn features and embedding ablations; do not lower promotion
   gates simply to activate a model.
2. Extract explicit backend process/build/cache-profile identity and request-to-engine
   attribution from existing DS4/API/OS evidence, with confidence and missingness.
   No engine edits; ambiguous log joins stay component-level. Then separate cache acquisition/prefill from reasoning/output cost;
   an endpoint fingerprint alone does not identify a surviving cache or engine.
3. Add calibrated uncertainty and bounded, versioned training-window selection.
   The trainer currently rejects oversized snapshots; design selection without
   deleting retained evidence or mixing incompatible backend eras.
4. Compare waiting for a warm home with local restore, remote fetch or cold prefill
   in shadow. Existing-session overflow requires a separate tested handover protocol;
   a promising ETA alone never authorizes moving active work or copying caches.

**Learning-system slice implemented:** named baseline/reset without disabling
learning, paired incumbent promotion gates, durable improvement announcements
and optional Genie-written milestone commentary. A reset is not a training pause;
pre-reset snapshots cannot immediately restore the rejected model. See the
[lifecycle controls](predictor-lifecycle.md#controls-gg-and-rollback).

**Gate Genie memory:** [a small operational notebook](genie-memory.md) now records
worker transitions, incident/recovery references, explicit operator intent and
bounded developer suggestions for exact code-selected failure envelopes. The
newest suggestions are visible in a compact top-of-page panel and remain labelled
hypotheses. Numerical telemetry and predictor artifacts remain authoritative;
memory grants no powers. Broader experiment lessons and search remain planned. Also track
[mutually beneficial upstream PR opportunities](ds4-integration.md#upstream-contributions)
without changing DS4 or creating a private-fork dependency.

**Implemented foundations:** [pre-assignment hint collection](client-metadata.md),
[three XGB recipe choices](predictor-lifecycle.md#reviewed-training-recipes), and
[read-only calibration preflight](calibration.md). Existing V2 artifacts remain
compatible while V3 collects and cross-validates per-request client, cache/load
and bounded request-shape feature blocks under a separate release contract. A V3
candidate runs in parallel and cannot inherit V2 validation. Next: reviewed training
windows and a proven non-displacing calibration adapter. No generation
runner/hourly toggle yet; preflight skips.
Ordinary training never invokes DS4.

Optimize **expected completion time**, including waiting, cache restoration,
prefill and generation—not raw tokens/second alone.

1. Collect ordinary workload evidence, marking missing, cancelled and truncated
   results. Record only the chosen server's actual result; other servers' outcomes
   are unknown, not invented training labels.
2. Add small, bounded calibration jobs for new devices only through a proven
   non-displacing path. Real jobs and warm production caches take priority;
   skip on uncertainty, including an idle server with unknown resident state.
   No large-context benchmark campaign by default.
3. Establish a simple measured baseline, then a narrowly scoped XGBoost predictor.
   Evaluate on later sessions held out from training. Prediction uncertainty and
   unfamiliar configurations must be visible.
4. Compare metadata-only prediction against optional **locally generated
   embeddings** of a bounded recent-conversation slice plus the latest user turn.
   Choose and pin an encoder, preprocessing, dimensions and truncation policy.
   Never silently send conversation text to a cloud embedding API.
5. Shadow routing first. Deploy only after measured validation, with a fixed,
   immutable compatible fallback model and deterministic routing fallback.

No encoder is automatically installed by the observer; the optional pinned local
bundle requires explicit preparation/configuration. Live XGB is optional and its
actual activation is reported by the local UI, not claimed by this public roadmap.
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

### Implemented first slice: Agent Watch for pre-gateway stalls

DSG could not distinguish an agent legitimately running a local tool from one
silent between that tool result and its next provider request. The opt-in Pi
heartbeat now exposes only a hashed run/session
reference, coarse state (`local_tool`, `waiting_for_model`, `idle`, `done`), last
activity, process liveness and the latest DSG request receipt. It must not include
the task, prompt, tool arguments or output. Correlating that heartbeat with DSG's
own queue evidence lets Genie say “client-side wait” or “no request reached DSG”
without blaming a DS4 server. The first slice is advisory and implemented; a
generic packaged Hermes adapter is not yet claimed. A later revive/nudge
operation requires an explicitly enrolled client adapter, one idempotent action,
current stale evidence and an action-ledger receipt; silence alone grants no power.

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

Long-context prefill can be expensive. A disk or remotely fetched checkpoint may
be much cheaper than repeating it. A hot cache is a useful advantage, not an
absolute routing rule. Choose the
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
disk or the conductor host a mandatory bulk-data bottleneck. Do not mirror every update to
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

## Future opt-in: Priority Lens

**Priority Lens** is the proposed UI name for intent-aware dispatch. When the
operator explicitly enables its persistent setting, DSG may give Gate Genie a
small bounded slice of the newest visible user request for each *undispatched*
stream. Genie can recommend which waiting work is most valuable to run next and
write a concise, separately colored dispatch explanation to the health wire.
This is proposed, not implemented or enabled.

The content boundary must be unusually obvious: default off; visible while on;
newest user text only; no system/developer messages, tool arguments, images,
hidden reasoning or whole conversation; a documented byte limit; and no raw
snippet in logs, training rows, receipts, notebook memory or browser snapshots.
The configured Genie provider receives the snippet, so the UI must identify that
trust boundary before opt-in. Turning the feature off stops new content capture
immediately and returns scheduling to the deterministic policy.

Genie supplies a bounded recommendation, reason category and confidence—not a
queue mutation. Fixed code enforces eligibility, session/cache continuity,
operator holds, starvation protection, FIFO aging, a maximum priority advantage
and idempotent receipts. It can reorder only requests that DSG has not dispatched;
it cannot interrupt or replay active work. Missing, late, malformed or failed
advice is a deterministic abstention, never a blocked request.

Chat may help the operator refine durable preferences such as project priority,
deadline sensitivity, background-work treatment and maximum tolerated starvation.
Genie should propose a concrete, reviewable policy delta; the UI shows and applies
that version explicitly rather than silently treating conversational prose as
authority. Every applied decision records only bounded metadata: policy version,
priority class, reason category, alternatives considered, decision time and
eventual wait/outcome. This gives us audit and learning evidence without retaining
the request text.

Acceptance: opt-in persistence and opt-out, provider-boundary disclosure, content
exclusion/redaction tests, zero raw-text persistence, bounded inference timeout,
starvation/adversarial-prompt resistance, same-session/cache invariants, decision
receipts, deterministic fallback and a shadow-only evaluation showing that the
policy improves an operator-defined objective before it gains routing authority.

## Lightweight hardware telemetry — first adapters implemented

Add an optional low-rate hardware lane after maintenance hand-back recovery is
complete. It must not slow the routing/control loop or require changes to DS4.

The aggregate fleet-speed tile now defines and tests the downstream power
contract: adjacent measured watt samples may produce kWh and tokens/kWh only
when every current device has dense coverage. Fixed DGX Spark/NVIDIA Linux and
generic local numerical-file adapters now supply that schema when explicitly
configured; otherwise it intentionally remains in **energy awaiting power data**.
No TDP or speed-derived placeholder is allowed.

- Keep availability, queues, quarantine and recovery state responsive through a
  small fast/event-driven lane, but refresh decode/prefill and hardware charts
  every **10 seconds**. Do not make a critical alarm wait on the chart timer.
  Measure payload and browser work after the split rather than slowing every
  safety signal indiscriminately.
- Three compact 15-minute sparklines per server now show memory used,
  accelerator activity and power draw; current clock is secondary context.
  Platform-specific pressure evidence remains future work.
- One allowlisted numerical schema now sits behind platform-specific, opt-in
  adapters. Spark/Linux uses supported NVIDIA/system counters; macOS and external
  meters have an explicit local JSONL boundary so a missing privileged power/GPU
  metric remains unknown rather than zero. An explicit local-only Mac adapter
  now reads occupied host RAM and single-driver GPU activity without privilege;
  power and clocks remain unknown and live enrollment still needs validation.
- The adapter may be reached through an already enrolled management transport,
  but it accepts no caller-supplied command. Bound execution time, output, sample
  history and cardinality. Hardware telemetry grants no restart or routing power.
- Label memory semantics honestly across unified-memory Macs and Sparks. Separate
  host memory pressure from accelerator allocation when the platform exposes both;
  never call a proxy “GPU RAM” without proof.

Implemented evidence covers mixed-adapter fixtures, missing/unsupported metrics,
stale data, timeout/reconnect, bounded history, fixed SSH arguments and no private
host/path/command leakage. Read-only Spark canaries have now returned RAM, GPU
activity, clock and explicitly GPU-only power measurements. Persistent activation
and measured dashboard CPU/network overhead still need validation; the UI stays
unchanged when hardware telemetry is not configured.

The private dashboard-to-core snapshot bridge and explicit V4 XGB contract now
cover admission, upload, embedding completion and progress stages. Synthetic
training proves hardware inputs can reach selected/exported tree splits, not
that they improve this fleet. Remaining acceptance work is:

- activate the dashboard collector and core ingestion without unapproved request
  interruption, then verify fresh saved evidence and coverage by worker/stage;
- provide a deliberately enrolled Mac measurement source;
- train V4 on real collected traffic, compare hardware/no-hardware alternatives,
  and retain the incumbent unless holdout and fresh-live gates pass;
- measure collection/serialization/browser overhead and preserve a clear
  distinction between GPU-only power and whole-device energy coverage.

V3 remains the default training contract pending those checks. No live model is
claimed to use hardware solely because the collector or V4 implementation exists.

## How this roadmap grows

Keep proposed, implemented, experimentally validated and enabled capabilities
distinct. Add tests and evidence alongside features, keep operator deployments and
training data out of this public repo, and prefer small reversible releases.
