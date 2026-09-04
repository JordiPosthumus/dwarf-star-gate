# Dwarf Star Gate work log

This is the short, human-readable record of meaningful DSG progress. It answers
“what did we build, and why does it matter?” without reproducing every commit or
private deployment event.

For implementation detail, see the [changelog](CHANGELOG.md). For exact history,
see [Git commits](https://github.com/JordiPosthumus/dwarf-star-gate/commits/main/).
For unfinished work, see the [roadmap](docs/roadmap.md).

## Recent reliability and intelligence sprint — 2026-09-03 to 2026-09-04

- **Bounded inventory directory traversal.** Unrelated files now count toward a
  separate scan budget so they cannot cause unbounded synchronous traversal.
  Partial inventories stay inconclusive for cache absence; DS4 caches are untouched.

- **Recovered unnecessary overlap abstentions.** The offline audit can now use
  an independently corroborated other owner to distinguish nearby engine starts.
  Fresh-traffic validation recovered additional matches while unresolved cases
  stayed unknown; no cache-hit or protocol-identity claim follows from this.

- **Explained remaining attribution overlaps.** Fresh-traffic audits now identify
  competing starts with existing ownership versus unresolved evidence, helping
  target safe reconciliation improvements without guessing request identity.

- **Added an unprivileged Mac telemetry option.** Local host RAM occupancy and
  driver GPU activity can now be collected through explicit enrollment. Power
  and clocks stay unknown rather than guessed; live activation remains separate.

- **Covered hardware at every forecast stage.** Upload and embedding completion
  now carry their own snapshots. Synthetic training proves that hardware signals
  can reach selected/exported XGB splits; this is plumbing evidence, not a claim
  of improved prediction accuracy on the live fleet.

- **Connected hardware measurements to forecast evidence.** A private bounded
  snapshot now links dashboard collection to admission/progress records, with
  freshness, identity and privacy checks. Deployment and validated V4 training
  are still required before claiming production prediction benefit.

- **Prepared causal hardware features for XGB.** An explicit V4 challenger can
  compare fresh, already-observed hardware readings against no-hardware models.
  Tests guard identity, timing, missing values and replay parity. Live ingestion
  remains the next step; existing default models are unchanged.

- **Display available GPU power honestly.** The Spark collector now uses measured
  GPU power when module readings are unavailable, without turning it into a
  whole-machine kWh claim. Parser and energy-boundary regressions pass.

- **Validated the Spark hardware adapter against real drivers.** Read-only probes
  returned RAM, GPU activity and clock samples. Documented the important missing-
  module-power case: a narrower GPU power reading must not become a fictional
  whole-device energy estimate. Predictor ingestion remains unfinished.

- **Fixed frozen live forecasts.** Progress predictions were recorded but usually
  failed to replace the first live estimate. Regression tests now cover refresh,
  out-of-order evidence, experimental candidates and incumbent support limits.

- **Stopped stale predictions masquerading as live ETAs.** Server cards now name
  stale or exceeded forecasts explicitly and distinguish total service time from
  time remaining. Genie receives the same interpretation rules.

- **Exposed multi-hour prediction failures.** Candidate and baseline reports now
  separate hour-plus targets from shorter work, including bias and coverage.
  Repeated progress samples cannot outweigh other requests within a band, and
  missing examples are explicitly unknown. Existing promotion gates stay intact.

- **Corrected the hot-cache comparison.** A warm prefix still needs its new suffix
  processed. The shadow comparator now counts that cost explicitly, with a
  regression demonstrating how it can change which path is fastest.

- **Made long slot occupancy visible.** Active request age now sits on each server
  card. Long requests with waiting work raise a capacity advisory, including fresh
  engine token progress where available. This explains missing completions without
  cancelling work or treating long reasoning as a proven hang.

- **Made attribution upgrades measurable on fresh traffic.** The audit accepts a
  UTC start-time cutoff while retaining older collision and ownership evidence.
  Operators can compare post-upgrade samples without mixing in legacy telemetry
  or manufacturing matches by discarding surrounding history.

- **Bounded Agent Watch during gateway holds.** One outstanding heartbeat per
  reporter prevents telemetry from accumulating in the Continuity Door. Session
  changes cancel obsolete calls; regression coverage checks 100 overlapping
  ticks and protects the new session from old-call cleanup.

- **Gave Genie privacy-safe sight of the client-side gap.** Opt-in Agent Watch
  heartbeats distinguish local tool work, DSG queueing, active model responses
  and a client that reports waiting before any request reaches DSG. The UI keeps
  quiet/stale clients explicitly unknown; there is no prompt capture, revival
  power or inference-side behavior change.

- **Stopped automation from stealing hardware under maintenance.** Named durable
  locks now explain why a server is deliberately out of service and hard-veto
  operator Resume, agent cleanup, Genie recovery and verified profile hand-back.
  Review deadlines warn rather than auto-expire; exact release leaves the worker
  paused until a separate checked Resume. UI, CLI and receipts all use the same
  private serialized executor.

- **Gave the fleet pulse honest hardware senses.** Opt-in, ten-second adapters
  now turn measured Spark compute-module or external whole-system power into the
  kWh/efficiency footer, while compact server-card strips show RAM, accelerator
  activity and power with clock as context. Unsupported fields stay unknown;
  nothing edits DS4 or grants the observer a control lever.

- **Made fleet value visible without vanity arithmetic.** The old completion-
  bucket headline is replaced by compact 1h/12h/24h decode and prefill gauges
  based on cumulative DS4 timing deltas and real active seconds. A thin arc shows
  observed activity coverage; the footer adds generated tokens and is ready to
  show measured-power-derived kWh and tokens/kWh once every device has sufficient
  coverage. Missing power remains unknown, never an invented TDP estimate.

- **Made the Genie's value auditable at a glance.** A compact newest-first ledger
  now merges proven pool commandeering, Genie recovery and predictor receipts,
  and bounded queue moves with useful filters. Exact borrowed servers appear only
  when DSG proves them; operator actions, request identities, prompts, answers,
  endpoints and raw errors stay out.

- **Made the Genie's generous provider deadlines real.** A hidden five-minute
  response-header limit in Node's Fetch transport could terminate both the
  dedicated review and its DSG-pool fallback despite the visible two-hour
  policy. Genie now uses a loopback-only streaming transport governed by the
  configured deadline, and the UI names both attempted providers when both fail.
  No gateway request, worker setting or model-server deadline changed.

- **Made interrupted streams explainable without pretending to recover them.**
  DSG now records whether an SSE response ended cleanly between events, was cut
  off inside an event, declared an engine error, exceeded the observation bound or
  reached a real terminal event. Genie can propose a test for the exact shape;
  response bytes are unchanged, no request is replayed and no text is retained.

- **Fixed crowded server-card headers.** Identity and ETA now stay together while
  backlog, phase and routing controls occupy a clean responsive row on ordinary
  card widths. A narrow-viewport browser assertion prevents controls escaping the
  card, and the public synthetic screenshots were refreshed.

- **Split the growing control room into five focused views.** Fleet remains the
  default; Gate Genie, Analytics, Activity and capability-gated Settings each get
  a stable tab while the health wire and important notices stay visible everywhere.
  The fleet summary is now one dense status band, and enrollment/configuration no
  longer pushes live server cards down the Fleet view. Keyboard navigation, URL
  hashes, polling state and mobile overflow are browser-tested, with no change to
  routing or model servers.

- **Restored a trustworthy cross-platform CI signal.** Launchd recovery tests
  now preserve the runner's real file-owner identity while checking the exact
  per-user launch target, and the worker-free shadow test verifies its durable
  evidence row rather than a transient latest-event slot. Linux and macOS matrix
  legs finish independently, and pinned Actions use their Node 24-based v5
  runtimes instead of emitting Node 20 deprecation warnings.

- **Closed the changed-profile recovery trap without trusting arbitrary code.**
  A stable changed profile from the same enrolled machine/service can now be
  adopted through a default-on sub-policy only after ownership and fatal-or-new-
  invocation proof. The exact service is then verified through model/context,
  generation and two cold-to-warm conversations before routing returns. Pauses
  and agent holds win; Genie can request the action but fixed code proves it.

- **Designed Priority Lens without quietly capturing request text.** The public
  roadmap now specifies a default-off intent-aware dispatch experiment: bounded
  newest-user snippets, an explicit Genie-provider trust boundary, no raw-text
  persistence, deterministic starvation/cache/session gates, auditable metadata
  and immediate fallback when Genie abstains or fails. No capture or routing
  authority was enabled by this planning change.

- **Made lost capacity impossible for a sleeping Genie to hide.** Quarantine and
  enabled-but-unavailable headlines now come directly from current DSG evidence,
  ahead of any model commentary. Planned pauses and agent reservations do not
  raise false alarms, and no private fault identifier enters the wire.

- **Fixed stock DS4 snapshot discovery before trusting cache decisions.** A
  source-and-log audit proved that DS4 writes `<40-hex>.kv`, while DSG's new
  inventory prototype looked only for a bare 40-hex name. The scanner now uses
  the exact stock shape, ignores lookalikes, and derives the same private HMAC
  from either the filename or canonical stem so later log/inventory correlation
  need not retain a prompt-derived cache name.

- **Kept long overlap evidence alive without weakening attribution.** Completed
  request windows that overlap a long-running peer now survive the short history
  until every candidate has terminated. Candidate retention is private and
  bounded; eviction keeps the start abstained instead of manufacturing a unique
  owner. Regression tests cover multi-hour resolution and capacity pressure.

- **Made cache continuity auditable without retaining conversations.** A bounded
  CLI now measures reuse across consecutive same-session completions, names every
  abstention, and refuses to turn missing client/epoch evidence into an accusation.
  It is aggregate, read-only and deliberately disconnected from routing/cache
  movement. Tests cover the privacy boundary and false-positive guards.

- **Added the missing macOS recovery boundary.** An explicitly enrolled launchd
  helper now offers the same exact-service, durable-intent and verified-readmission
  contract as systemd without accepting arbitrary commands. It is source-complete
  and synthetically tested; no Mac was touched, and each deployment still needs a
  private drained canary before automatic recovery is eligible.

- **Made predictor validation blockers explainable.** The current remaining-time
  candidate reached 30 future requests across 6 sessions but correctly remained
  pending because only one of three required fresh long jobs had arrived. DSG now
  reports that exact subgate without changing the model, evidence window, routing
  or promotion policy.

- **Made prediction evidence audits relocation-aware.** Valid queued handovers
  and tie-break shadows no longer look corrupt; the audit distinguishes proven
  moves from unexplained worker joins, and moved work cannot label the source
  forecast or linger in predictor memory.

- **Recovered safe later attribution evidence without revising history.** A
  bounded read-only join can revisit old clock overlaps once exact returned usage
  exists, while collisions, incomplete files and missing usage still abstain.

- **Restored evidence for local Mac attribution.** DSG now carries a privacy-safe
  stock-log process digest from a proven listen marker to later timing records in
  strict file order. Missing markers and rotations abstain instead of inheriting
  stale identity.

- **Defined the cache-continuity decision without activating it.** A tested pure
  shadow now compares waiting for a hot cache, restoring locally, acquiring a
  remote snapshot or prefilling cold. Missing evidence blocks a winner, remote
  overlap must be proven, and no cache or routing state can be touched.

- **Started the privacy-safe cache-continuity auditor.** DSG can opt into bounded
  same-host or read-only-mounted cache inventory using only stock DS4 header
  metadata. Prompt bytes, paths and raw prompt-derived names stay private; no
  cache or routing state is touched. This supplies trustworthy inventory evidence
  for the coming wait/restore/fetch/cold shadow comparison.

- **Closed the worker credential boundary.** DSG's client bearer key now stops at
  the gateway. Stock DS4 workers remain private behind loopback or authenticated
  SSH, and receive neither the ingress key during inference nor metadata probes.

- **Made planned gateway maintenance continuity-safe.** The Continuity Door holds
  new request bodies unread while existing streams drain, swaps only the gateway
  core, verifies readiness, and forwards each held request once. It does not spool
  prompts or pretend to recover an interrupted generation.

- **Made DS4 outages patient instead of immediately fatal to clients.** Requests
  that have not yet been dispatched can remain attached while their server
  recovers, keeping original deadlines, queue order and conversation ownership.

- **Added safe pre-dispatch rebalancing.** A mature queued request can move to a
  truly idle server while preserving the original client socket and deadline.
  Same-session overlap, dispatch, pause, quarantine and failed durable state all
  block movement.

- **Put the deterministic balancer in the gateway core.** Eligible overflow no
  longer depends on the dashboard or Gate Genie being awake. Strict-affinity
  deployments can keep the feature disabled.

- **Turned Gate Genie into a bounded fleet assistant.** Genie is enabled by
  default once configured, can use a dedicated DS4 endpoint, and may borrow one
  unpinned pool slot if that provider fails. Reviews, attempts and action receipts
  are visible without exposing endpoints or credentials.

- **Made Genie chat and long reviews practical.** Manual questions pre-empt routine
  reviews, scheduled reviews no longer loop back-to-back, and provider deadlines
  now allow long-context local reasoning while showing real progress in the UI.

- **Gave Genie useful memory without hidden authority.** An opt-in private notebook
  keeps revisioned operator notes, evidence-linked incidents and bounded developer
  hardening suggestions across dashboard restarts. Suggestions can reference only
  code-selected failure envelopes; no prompt, answer, image or arbitrary log text
  is collected. Remembering a fact does not grant an action.

- **Added narrowly enrolled DS4 service recovery.** For supported systemd-user
  installations, DSG can restart a proven fatal instance—or start a specifically
  enrolled stopped service—then verify generation and two cold-to-warm prefixes
  before readmission. It cannot invent shell commands or change model settings.

- **Added a scoped control surface for other local agents.** Per-agent grants,
  owned drain holds and durable idempotency receipts let an authorized agent take
  a server out for work and return it without overriding operator pauses or
  another agent's reservation.

- **Built an evidence-gated XGBoost lifecycle.** Admission, after-upload,
  embedding-aware and remaining-time forecasts use causal, versioned evidence.
  Tree count and bounded feature groups are cross-validated inside training;
  separate holdout and future-traffic gates protect activation.

- **Kept learning reversible.** DSG retains a measured baseline, requires a
  challenger to beat both baseline and incumbent on matched evidence, records a
  learning milestone, and supports rollback or reset without switching collection
  off. Gate Genie can request reviewed training, not promote a model by assertion.

- **Collected better workload evidence without storing conversations.** Bounded
  request shape, numerical usage, previous-turn history, optional local embeddings
  and 30-second progress signals feed shadow models while prompts, answers and
  hidden reasoning remain outside the dataset.

- **Added measured cache-acquisition components.** The dashboard can compare
  observed local-disk load and cold-prefill costs while explicitly abstaining when
  cache existence, compatibility, freshness or remote-transfer cost is unknown.

- **Established DS4 process epochs and conservative request attribution.** Systemd
  invocation evidence and bounded local DS4 listen markers prevent cache telemetry
  from crossing engine restarts. Gateway windows plus returned usage can
  corroborate an engine start, but ambiguity still abstains.

- **Added an attribution-yield audit.** DSG now measures final corroboration and
  abstention causes per server over bounded evidence files, without returning
  prompts, responses, request IDs, sample IDs, paths or credentials. This is the
  foundation for a trustworthy cache-health auditor.

- **Protected client sessions from proven image compatibility failures.** Rejected
  JPEGs may be normalized once on the same server. Proven GIF cases become useful
  completed guidance turns. Proven GIF/over-16-image requests now receive one
  model-driven recovery call with explicit diagnostics and no gateway-selected
  image subset; the agent chooses what to do, client history is untouched and
  unrelated 400 responses remain unchanged.

- **Made fleet state much harder to misread.** The dashboard now distinguishes
  healthy, paused, quarantined and unreachable servers; counts only DSG-owned
  queues; shows control provenance; and uses compact prefill, generation and
  idle/off activity bands.

- **Added dense operational telemetry.** Hourly output, peak rolling throughput,
  request completions, prefix reuse, queue age, cache evidence and per-server
  prefill/decode rates are visible without claiming they are GPU utilization.

- **Unified installation and lifecycle management.** Source, ignored private
  configuration and ignored runtime state live in one checkout. Guarded start,
  stop and park scripts preserve state, back up control data and avoid restarting
  already-running components unnecessarily.

- **Strengthened the public repository itself.** Synthetic screenshots, N-worker
  fixtures, full local regression coverage, privacy guards, documentation of
  boundaries, strong upstream DS4 credit and publication checks now travel with
  the code.

## How this log is maintained

Add an entry only for a meaningful user-facing capability, reliability boundary
or operational milestone. Combine related commits into one plain-language bullet.
Do not add screenshot refreshes, refactors with no behavior change, private
deployment incidents, machine addresses, credentials, prompts or benchmark claims
that the public fixtures do not establish.

The work log is a progress map, not a release certification. Source changes still
need the tests, deployment procedure and hardware-specific validation described in
the repository documentation.
