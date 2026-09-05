# Dwarf Star Gate work log

This is the short, human-readable record of meaningful DSG progress. It answers
“what did we build, and why does it matter?” without reproducing every commit or
private deployment event.

For implementation detail, see the [changelog](CHANGELOG.md). For exact history,
see [Git commits](https://github.com/JordiPosthumus/dwarf-star-gate/commits/main/).
For unfinished work, see the [roadmap](docs/roadmap.md).

## Recent reliability and intelligence sprint — 2026-09-03 to 2026-09-05

- **Closed a model-discovery gap in planned core restarts.** A disposable fixture
  reproduced discovery escaping the Door's hold and returning a 503. Discovery
  now waits and forwards once after release. Bounded transport-failure evidence
  distinguishes status polls from inference without claiming backend execution
  or replay safety. Genie receives those distinctions. Door activation requires
  its own idle window; a core-only restart does not load this fix.

- **Made the forecast-data denominator explicit.** A read-only, hash-verified
  snapshot census distinguishes scored completions, label exclusions, unsuccessful
  terminals and unresolved admissions. The first paired future snapshot had
  20 labeled completions out of 36 admissions; two queued cancellations would
  have been mistaken for unresolved work by a finish-only count. No missing
  terminal is called a failure, and no label or production behavior changes.

- **Checked both frozen occupancy models on genuinely later traffic.** A shared
  snapshot of 20 new completed requests found no meaningful overall gain from
  corrected delivery semantics; both models still underestimated the two longer
  jobs at admission. Added offline remaining-error slices by elapsed service age
  so early forecasts cannot be confused with forecasts made minutes into a job.
  Original scores and artifact hashes reproduce unchanged. No model was promoted.

- **Hardened later-evidence attribution against contradictions.** Reproduced two
  false-match cases in the offline auditor: mismatched engine-start identity and
  a conflicting request being discarded from the candidate set. Both now abstain.
  A fresh fleet audit still resolves the same 55 valid historical overlaps; no
  telemetry is rewritten and competing starts with unproven owners stay unknown.

- **Stopped counting accepted reason-only streams as worker failures.** A real
  Pi fixture completed its tool and answer while DSG incorrectly logged two
  failures because `[DONE]` was absent. Explicit, unambiguous finishes at clean
  EOF now have their own diagnostic; interrupted transports remain failures.
  No content is fabricated or replayed, and no existing quarantine is cleared.

- **Separated delivery bursts from assumed decode speed.** An offline challenger
  retains socket-timing evidence under accurate names, adds prior service/window
  features and removes the hard-coded decode interpretation. Original models,
  raw data and live routing stay unchanged; matched comparisons and independently
  frozen future traffic must establish whether the new contract actually helps.
  The first matched comparison improved admission forecasts but not updated ones;
  remaining forecasts barely changed. No candidate was promoted, and a weaker
  corrected baseline is explicitly not counted as a model improvement.

- **Validated Mac bootstrap against a real disposable LaunchAgent.** The native
  test found a missed `bootout initiated by` event format. DSG now distinguishes
  stop initiation from completed removal, preserves the ordinary-stop veto, and
  permits that evidence only for an explicit operator canary. Native checks proved
  exact-byte restoration, changed process/same profile, duplicate suppression and
  cleanup. This is lifecycle proof, not a DS4 generation/cache certificate; real
  worker enrollment and controlled installation validation remain required.

- **Made Genie's work easier to inspect.** The filtered action ledger now renders
  the latest 30 available receipts in a keyboard-scrollable list; recovery and
  predictor feeds expose 30, and small pool-fallback receipts survive review-text
  rotation within the dashboard run. Sharper review instructions ask for specific
  diagnostic tests, distinguish transport errors, and reject blanket replay advice
  or repetitive notebook updates. These prompt rules are not verified diagnoses.

- **Connected removed-Mac-job recovery to the independent controller.** Matching
  enrollment and an acknowledged removed-job cold/warm canary gate ordinary
  offers. Durable maintenance holds, admitted work and native policy are rechecked;
  restart reconciliation never resends bootstrap. Genie uses the existing exact
  offer API, not new command or canary authority. Live installation validation is
  still required, and uncertain issuance is labelled honestly in receipts.

- **Built the one-shot removed-Mac-job helper action.** Separate opt-in authority
  permits only exact pinned launch bytes and approved native removal callers.
  Fixtures verify private byte-preserving staging, native disable/port/identity
  vetoes before and after durable intent, and no command replay after an uncertain
  acknowledgement. Controller integration and a real removed-job canary remain
  unfinished; no live service or recovery enrollment changed.

- **Connected native Mac removal evidence to Genie.** The enrolled helper can
  query the OS directly for a missing job's retained PID/boot, with bounded pipes
  and checks before/after capture. The controller rate-limits queries and rejects
  stale results; Genie receives caller/time diagnostics, not raw logs or a new
  recovery offer. A real historical incident confirmed the query/parser path.
  Automatic restoration policy and a real removed-job canary remain unfinished.

- **Added a retained-definition preflight for Mac recovery enrollment.** An owner's
  agent can verify a private hash-pinned plist without rewriting any settings or
  touching services. Tests cover XML/binary byte preservation, drift, duplicate
  keys, retained disable intent, private file boundaries and concurrent changes.
  This prepares exact removed-job restoration; it grants no bootstrap authority.

- **Closed a Mac recovery readmission race.** A regression reproduced a native
  disable arriving during generation verification but still clearing quarantine.
  Fresh policy checks now guard action, verification and final readmission/profile
  adoption, including stopped starts, canaries and reconciliation without command
  replay. These are sampled checkpoints, not instantaneous cancellation. Gateway
  activation is separate; no worker or model settings change.

- **Found the missing native removal evidence.** launchd stores the exact job/PID
  in its structured subsystem, so message-only searches missed the caller record.
  Added a bounded offline auditor for exact identity/boot/time matching, incomplete
  captures and conflicting callers. It exposes no raw log text and grants no
  recovery authority; an OS caller does not prove the stop was accidental.

- **Made Mac recovery respect native disable instructions.** The launchd adapter
  now checks macOS's explicit service-disable override and rechecks before issuing
  a command. Unknown evidence blocks action; Genie and alerts explain the native
  stop intent. Regression tests cover canaries, stopped starts and a disable racing
  the durable receipt. This is a bootstrap prerequisite, not removed-job recovery.

- **Separated a stream ending from Pi accepting it.** A real installed Pi fixture
  rejects `[DONE]` without a recognized finish reason. DSG records that bounded
  compatibility fact, separately from observer gaps, and gives Genie a developer
  hypothesis without restart authority. Response bytes, transport counters and
  replay/quarantine policies remain unchanged. This diagnoses a stopping condition;
  it does not claim to resume an already dispatched failed turn.

- **Fixed readiness races at the Continuity Door.** Isolated HTTP reproductions
  proved an unresolved truncated health response and a stale successful probe
  releasing a newer automatic hold. Health checks now settle once, coalesce,
  expire at their configured deadline and become invalid across hold transitions.
  Tests preserve manual reservations and cancellation accounting. No model work
  is replayed or given a shorter deadline; live activation needs a safe Door window.

- **Made post-collector model experiments reproducible.** The normal all-history
  split left new hardware measurements exclusively in the holdout. Added an
  explicit offline admission-time cohort with full raw snapshots, retained older
  causal priors and selection provenance. Training/CV now has genuine post-cutover
  telemetry when evidence is available; all existing minimum-support and future
  validation gates remain unchanged. No live model replacement or data deletion.

- **Checked genuinely later traffic and made model diagnostics explicit.** Fresh
  Mac attribution gained corroboration from later completion evidence without
  relaxing collision guards. The frozen occupancy challenger still failed to
  beat the fixed baselines; it remains offline. Future audits now expose live
  hardware collection versus actual model use and upload versus embedding-stage
  accuracy. Private evidence stays private; no holdout retuning or promotion.

- **Retained bounded Mac service identity evidence.** A private last-instance
  snapshot survives gateway restart, without writing on unchanged polls or
  exposing process/profile details. Tests reject malformed evidence and changed
  enrollment; a historical snapshot cannot authorize recovery. Exact OS-removal
  attribution and bootstrap execution remain the next steps.

- **Separated a missing Mac job from a failed inspection.** Recovery now reports
  missing registration, unavailable GUI domain and unknown inspection separately.
  Genie and deterministic alerts explain the actual block; none grants bootstrap
  authority. Repeated absence checks handle a job appearing during inspection.

- **Made recovery setup an agent handoff.** A linked guide addresses the owner's
  local agent directly: inspect, propose exact authority, obtain approval, preserve
  settings, privately enroll, run an approved canary and report measured results.
  The README and recovery UI link to it. It explicitly separates fleet-wide policy
  from one worker's setup and does not grant permission just by being copied.

- **Fixed a reproduced stopped-service recovery collision.** Both helpers used
  to report no listener whenever the enrolled process was absent. Real unrelated
  IPv4/IPv6 listeners now veto start, with regressions for wildcard and bound
  sockets, unknown errors and cleanup. No live service was restarted for this fix.
  Added a short enrollment entry point distinguishing connection, identity setup
  and the disruptive verification canary; a browser setup wizard remains work.

- **Added an opt-in same-host Mac recovery transport.** An enrolled interpreter
  and private helper config can now use literal arguments and JSON stdin without
  SSH or shell execution. Existing recovery guards remain; automatic enrollment
  and removed-job bootstrap are not implied. Also fixed helper-output handling
  so final bytes arriving after process exit are not lost.

- **Clarified the Mac recovery boundary.** Restarting a loaded service cannot
  recover an OS-removed registration. The plan now explicitly covers same-host
  transport, an enrolled retained definition, stop-intent protection and a real
  removed-job canary before granting Genie bootstrap authority.

- **Separated provable non-delivery from ambiguous failures.** A fresh TCP
  connection refused before establishment can now tell a compatible patient
  client to retry its unchanged request. Connected resets and image-repair
  follow-ups cannot receive that certificate; the gateway never replays them.

- **Fixed a reproduced Door cancellation race.** A client closing its own request
  could make healthy core connectivity look broken. Cleanup now records the
  cancellation first, while genuine upstream failures retain their safeguards.
  Source/test completion is separate from a safe stable-endpoint reload.

- **Checked what safe KV transfer would require.** Pinned upstream source confirms
  disk-cache discovery and restore building blocks, but cache files also contain
  prompt text. Recorded identity, privacy, integrity and isolated continuation
  canaries before any transfer authority; no live cache files were moved.

- **Made applied handovers measurable.** The private data audit now joins moves
  to their observed queue, service, reported reuse and terminal outcomes. It
  abstains on ambiguous evidence and never presents the unobserved no-move
  alternative as measured time saved.

- **Verified hardware ingestion through the real core callbacks.** Fake-backend
  integration tests cover decision, after-upload and progress records, worker
  identity, privacy filtering, stale/malformed samples and disabled collection.
  Missing telemetry must not change inference bytes or quarantine a worker.

- **Fixed mutable-request retries.** A reproduced client-side race could reuse
  changed URL/options after a certified wait. The transport now pins the original
  destination, body and cancellation signal, without changing patient deadlines
  or granting replay authority for dispatched work.

- **Investigated a narrow upstream observability opportunity.** Checked current
  DS4 request parsing and related PRs; recorded bounded request correlation as
  a candidate, with privacy, compatibility and test requirements. No DS4 change
  or PR submission was made.

- **Narrowed a Mac recovery identity race.** Metadata inspection now rechecks
  start time as well as the executable path. Same-binary PID replacement must
  abstain; this is not a claim of atomic restart safety or a live recovery canary.

- **Added a frozen occupancy future audit.** Bind the challenger and training
  artifacts before new traffic, then evaluate only new, completed jobs with the
  same feature/profile contract. Report errors and fixed baselines without
  retraining, promotion authority or claims of live routing benefit.

- **Verified full-size attribution audits.** The supported 250,000-record input
  no longer overflows JavaScript's function-argument limit. The minimum-time
  calculation avoids an extra timestamp array; attribution rules are unchanged.

- **Removed false confidence from cache shadow evidence.** Conflicting snapshot
  entries and unspecified scan completeness now abstain rather than claim a
  usable cache or proven absence. No live cache or routing behavior changed.

- **Established the guiding light.** Dependable scheduling and agent continuity
  come first; Genie and predictors improve that foundation without becoming a
  dependency that can stall it. The roadmap records how milestones earn trust.

- **Verified maintenance isolation during balancing.** A mock-server regression
  proves stale operator/Genie offers cannot reclaim a newly reserved worker.
  Automatic balancing waits for lock release plus explicit routing resume.

- **Made long-job validation coverage explicit.** Training, holdout and each
  forward-time fold now report duration-band points, requests and sessions.
  Repeated progress cannot masquerade as independent long-job evidence; this
  diagnostic leaves model selection and production gates unchanged.

- **Recovered early long-job progress for offline occupancy.** Replay no longer
  inherits the live rolling history's tail-only retention. Earlier hour-plus
  targets stay visible, with request-balanced evaluation and unchanged live limits.

- **Added explicit offline occupancy training.** The reviewed forward-time XGB
  search can now fit the separate target, with capped/normal holdout diagnostics.
  Preparation fingerprints its contract; production loading is explicitly rejected.

- **Built separate occupancy training labels.** An offline contract now includes
  verified capped terminal durations without contaminating natural-completion
  priors or leaking terminal outcomes into features. No production model changed.

- **Explained the long-job training gap.** The data audit now separates normal,
  output-limited, unverified and failed/cancelled durations. Long capped runs stay
  recorded without masquerading as natural completions; occupancy modeling is
  the next distinct forecast extension, not a silent eligibility change.

- **Corrected Mac recovery executable identification.** Real DS4 processes expose
  multiple shared-library text mappings. Recovery now queries the kernel's exact
  executable path instead; read-only live validation passed, with no service action.

- **Fixed Safari refresh scroll jumps.** Updating machine-card content now keeps
  the reader's viewport in place. A live WebKit reproduction moved 1,000px → 398px
  before the fix and stayed at 1,000px after it; a synthetic browser check covers polling.

- **Exercised real Pi continuity and its replay boundary.** Installed-agent
  fixtures passed patient waiting, certified retries beyond three attempts and
  a truncated post-tool stream. Tools execute once; ambiguous dispatched output
  is not silently replayed. Broader post-dispatch recovery remains unfinished.

- **Exposed future hardware coverage.** Challenger reports now separate training
  from holdout feature availability, and show hardware coverage by worker/stage.
  Missing sensors cannot hide behind a fleet-wide training average; gates are unchanged.

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
