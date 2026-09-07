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
roadmap dependencies. Priority Lens and Proactive Resume were also retired on
2026-09-07; the read-only Current Jobs view remains. The remaining delivery order is:

1. Fast Genie assignment: use eligible capacity promptly and validate provider
   failure boundaries without replaying ambiguous dispatched work.
2. Compact machine traffic lights: measured cache, prefill and decode evidence,
   with explicit unknown states where coverage is insufficient.
3. Hardware visibility: measured memory, accelerator activity, temperature and
   power; distinguish GPU-only measurements from whole-device energy.
4. Operational explanations: clear ownership, transport, outage and cancellation
   evidence that does not invent a root cause.
5. Recovery validation: preserve verified cold-to-warm behavior, model settings
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
copy caches or change routing. The speculative four-path comparator and
calibration preflight have been retired.

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
generic packaged Hermes adapter is not yet claimed. This is observation only.

### Session Rescue / Proactive Resume — retired

Automatic client continuation was retired on 2026-09-07. Agent Watch remains
advisory; it cannot submit new input or control a client session.

## Adding or removing devices

Use stable categorical worker identities plus shared hardware-class features and
configuration-labelled evidence, not machine-name-only predictions. New machines start with limited confidence,
compatibility checks and ordinary operational observations. Removed machines stop being routing
candidates; their measurements need not be erased. Never lower the pool context
guarantee just to admit an incompatible worker. The dedicated Genie endpoint is
not itself required to match the worker pool's context size.

## Cache comparison and calibration — retired

The four-path comparison, speculative cache-transfer direction and calibration
preflight were retired on 2026-09-07. Existing safe queued handover remains;
see the [current load-balancing rules](simplified-system.md#load-balancing).
Historical designs do not authorize further experiments.

## Current Jobs — read-only request visibility

Priority Lens and Proactive Resume were retired on 2026-09-07. Current Jobs
retains transient request previews, worker placement, state and timing without
classification, weighted scheduling, saved preferences or automatic new turns.

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
