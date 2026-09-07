# Feature roadmap

This is a living roadmap, not a claim that every feature below ships today.
Start with the [current work plan](current-work-plan.md) for the reconciled active
checklist and delivery order; this document preserves the detailed designs.
DSG remains a companion to [antirez's DS4 engine](https://github.com/antirez/ds4).
The engine performs inference and manages KV state; DSG observes and routes.
The [DS4 integration contract](ds4-integration.md) is explicit: learn the engine's
existing interfaces deeply; do not edit DS4 or require a custom server build.

## Delivery principles

**Seamless Continuity** is Dwarf Star Gate's tagline: keep agents working through
recoverable problems. It is our design direction, not a claim of universal
failure recovery or permission to bypass the continuity boundaries below.

Our guiding light is **a low-effort DS4 fleet that keeps agents working.
Intelligence should make that dependable foundation better—not become another
dependency that can stall it.**

- Core scheduling, maintenance isolation and certified retry safeguards must not
  depend on a successful Genie review. Respect reservations and session ownership.
- Prove deterministic balancing and measure realized operational benefit.
  Passive comparisons cannot change routing.
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

## Planned: actionable cache misses in machine cards

Replace the low-value “Cache + session evidence” summary with a compact view of
cache misses and their measured cost. Distinguish normal first/cold prompts,
resident RAM misses successfully restored from disk, and likely lost reusable
prefixes. Do not equate a RAM miss with a cold start or every cold start with a
bug. Report observation coverage, recency, repeated incidents and extra prefill
tokens/time where attribution is supported; otherwise show unknown cost/cause.
Expandable evidence should explain what happened and a justified next check.
Use the existing privacy-safe continuity audit and process/session evidence;
Genie may summarize patterns, but must not invent cache identity or certainty.
This is a planned UI/diagnostic change, not permission to move or delete KV data.

## Prioritized delivery order

The [current work plan](current-work-plan.md) records acceptance details. The
operator retired XGB and embeddings, including all model data, on 2026-09-07.
Training, learned placement, predicted remaining time and promotion are no longer
roadmap dependencies. The remaining delivery order is:

1. Priority Lens: useful stock-client job identification, manual and automatic
   priorities, accountable queue selection and real-model quality validation.
2. Fast Genie assignment: use eligible capacity promptly and validate provider
   failure boundaries without replaying ambiguous dispatched work.
3. Proactive Resume: optional client integration with duplicate/input guards and
   real continuation judgment; preserve normal installed client behavior.
4. Compact machine traffic lights: measured cache, prefill and decode evidence,
   with explicit unknown states where coverage is insufficient.
5. Hardware visibility: measured memory, accelerator activity, temperature and
   power; distinguish GPU-only measurements from whole-device energy.
6. Operational explanations: clear ownership, transport, outage and cancellation
   evidence that does not invent a root cause.
7. Recovery validation: preserve verified cold-to-warm behavior, model settings
   and cache retention; completed maintenance is recorded separately from
   unresolved retention questions.

Source, isolated validation, live activation and demonstrated benefit remain
separate acceptance claims. Ordinary routing never waits for Genie.

## Implemented foundation: evidence and bounded Gate Genie actions

**Queued-work evidence now implemented, opt-in:** [setup and limits](routing-shadow.md).
The original historical shadow still records per-worker/session clocks without
moving work, and it remains an unvalidated baseline rather than a cache-aware
router. Bounded UI explanations, backend process epochs, request-correlation
candidates and exact safe pre-dispatch handover ship as separate layers.
Remaining work measures realized outcomes and improves cache-acquisition
attribution. No fitted model is involved.

- **Operational request journal:** opt-in private numerical records of fleet load
  at admission, placement, queue/service durations, reported usage and failures.
  No raw conversations, answers, tool arguments, embeddings or model features.
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

## Genie operation: implemented powers and remaining work

The [Genie powers plan](genie-powers-plan.md) specifies the CUDA recovery scenario,
the separation of Genie/scheduler/executor, narrow action permissions, UI
controls, tests and shadow-to-canary deployment. Bounded systemd-user/launchd
recovery adapters, safe queued-handover offers and action
receipts are implemented. Installation-specific enrollment, canary evidence and
explicit opt-in are still required before automatic recovery is enabled. These
are not arbitrary shell powers; editable endpoint controls and active-request
revival remain separate work.

- Quarantine follows deterministic failure evidence. Genie requests only
  advertised recovery offers; independent executor gates decide readmission.
- Still to build: recover confirmed stuck requests while the client continues automatically.
  Mid-stream replacement needs client cooperation and tool-state reconciliation;
  appending a different answer to an existing stream is not transparent recovery.
- Keep manual controls authoritative and model inference independent of the Genie.
  His failure must never prevent ordinary routing.
- Pause/resume receipts now record time, targets, a durable action ID and a
  bounded control channel. That channel identifies the client path, not a verified
  human. Agent grants and named maintenance locks provide their separate ownership
  evidence; a plain pause receipt does not establish intent or a supplied reason.
  Broader actor/reason attribution remains work. Do not infer blame from a flag.

The opt-in Pi source extension already supplies scoped certified retries and
optional Agent Watch/admission metadata without shell access or provider-setting
edits. A standalone frozen distribution or generic Hermes package is separate
packaging work, not a prerequisite for the implemented Pi extension.

### Implemented first slice: Agent Watch for pre-gateway stalls

DSG could not distinguish an agent legitimately running a local tool from one
silent between that tool result and its next provider request. The opt-in Pi
heartbeat now exposes only a hashed run/session
reference, coarse state (`local_tool`, `waiting_for_model`, `idle`, `done`,
`needs_attention`), receipt freshness, client-reported liveness and the latest
tagged DSG request state. It must not include
the task, prompt, tool arguments or output. Correlating that heartbeat with DSG's
own queue evidence lets Genie say “client-side wait” or “no request reached DSG”
without blaming a DS4 server. The first slice is advisory and implemented; a
generic packaged Hermes adapter is not yet claimed. A later revive/nudge
operation requires an explicitly enrolled client adapter, one idempotent action,
current stale evidence and an action-ledger receipt; silence alone grants no power.

### Planned opt-in: Session Rescue

Delivery is linked to the [optional Pi integration contract](pi-integration-plan.md),
with separate capabilities and real-client acceptance tests. Start with an easy
settled continuation check-in, not process restart or unknown dispatched failure.

**User-requested, not implemented or enabled.** Let Genie study apparently stalled
Pi sessions and, when independently safe and explicitly authorized, help the
owning agent resume its existing task. This extends Agent Watch; it does not make
the gateway do the user's work or assume that every quiet session is broken.

- **Two permissions, off by default:** persistent observation enrollment and a
  separate automatic-resume toggle, scoped to an explicitly enrolled client and
  its sessions. Observation alone grants no control. Provide per-session exclusion,
  immediate revocation and a manual “review / resume” path. Protect intentional
  pauses, user aborts, completed tasks and sessions requiring genuine human input.
- **Diagnose before suggesting action:** correlate fresh client lifecycle and
  monotonic progress with DSG queue, dispatch and terminal receipts. Distinguish
  waiting for a slot, active reasoning/streaming, a long local tool, local retries
  or compaction, a settled recoverable failure, an unnecessary continuation
  check-in and unknown client state. Neither
  elapsed time, idle GPU telemetry nor a stale heartbeat proves a stalled agent.
- **Privacy-bounded study:** use structured lifecycle/error classes first, with
  bounded retention. Reading transcript, tool-output or user-request snippets
  requires separate explicit content permission, with scope and retention shown
  before enabling it. Never collect secrets or full transcripts by default;
  treat inspected content as untrusted evidence, not control instructions.
- **Judge what the agent is waiting for:** with separately authorized bounded
  task/last-turn context, Genie distinguishes “we got this far; should I keep
  going?” on an unfinished, already authorized task from a real decision for the
  human. In the routine-check-in case, the intended response is “Yes, continue
  the already authorized task.” A normal successful turn ending in that question
  can qualify; rescue is not restricted to error-ended turns. A preference or
  factual input the user must supply, broader scope, spending, destructive action,
  credentials, new access or an explicit instruction to wait must go to the human.
  Do not answer those questions by guessing, impersonate the user, or treat a
  question mark alone as authorization. Without enough trusted task/permission
  context to distinguish these cases, show “needs human review” and the reason.
- **Least-powerful recovery:** prefer Pi's supported, authenticated client-owned
  resume/control interface and reuse existing optional integration where suitable;
  verify actual Pi support before choosing a mechanism. No terminal keystroke
  injection, broad shell access, new mandatory companion or process restart.
  Genie proposes a concise diagnosis and continuation cue; the owning agent
  decides how to solve the task. A friendly gateway answer alone cannot cause
  Pi to schedule another turn.
- **Independent execution guard:** immediately recheck session identity, generation,
  ownership, permissions and lifecycle at the client. A settled recoverable turn
  or routine continuation check-in
  must have no outstanding tool, request, queued continuation, retry or compaction.
  An active/ambiguous prior execution requires positive reconciliation or human
  review, not blind replay. Use one durable idempotency receipt per failure/turn
  generation, bounded attempts and cooldown; recovered progress or user activity
  invalidates stale proposals. Fail closed on client restart or lost receipt state.
- **Visible outcome:** put the reason, evidence freshness, target pseudonym,
  decision (including “routine continuation” versus “needs human feedback”),
  action receipt and result in the existing newest-first Genie ledger.
  Distinguish suggested, blocked, resume accepted, progress confirmed and failed;
  command acceptance alone is not recovery. Repeated failure becomes a concise
  operator alert and hardening note, not an endless “proceed” loop.

Delivery: observation-only stalled-session review first; then operator-approved
single-session resume; finally separately opted-in automatic rescue after real
Pi integration tests. Acceptance must cover a settled recoverable failure resuming
without duplicate tool execution, routine “should I keep going?” continuation,
real approval questions and superficially similar risky requests, stale-review
races, concurrent controllers,
client restart, permission revocation, user stops, healthy quiet work, DSG queue
waits, missing heartbeat and unresolved post-dispatch failures. No active work may
be interrupted just to test this feature. Track confirmed recovery and false
intervention rates, not merely the number of nudges issued.

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

## Priority Lens — source implemented, delivery continuing

The [Priority Lens implementation and boundaries](priority-lens.md) document the
current-jobs UI, persistent overrides, explicit 30-line preference editor,
bounded conversation-head lottery, eligible-wait aging, optional Pi user-intent
handoff and asynchronous Genie classifier. The visible switch defaults on;
queue priority defaults to a configurable one-hour eligible-wait backstop. Pi content sharing
remains separately opted in. Source/tested behavior does not imply live rollout.

The implementation never waits for Genie in dispatch. Independent core leases
expire after 60 seconds; stale/manual-conflicting advice is rejected. New pool
classification requires a free compatible slot at actual admission. Model
options, normal Genie review deadlines, cache ownership and holds are preserved.

Genie chat now proposes conversation-only or general corrections, with explicit
confirmation, exact rule removals/additions, clarification and stale-revision
guards. Remaining: agreed activation settings, measured classification quality,
richer task lifecycle coverage and rollout validation.
Proactive Resume remains a separate optional Pi capability and permission.

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

Hardware measurements feed operational dashboards and energy evidence. The
model-feature bridge was retired with XGB. Measure collection and browser
overhead and retain the distinction between GPU and whole-device coverage.

## How this roadmap grows

Keep proposed, implemented, experimentally validated and enabled capabilities
distinct. Add tests and evidence alongside features, keep operator deployments and
operational data out of this public repo, and prefer small reversible releases.
