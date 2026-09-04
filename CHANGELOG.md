# Changelog

## Relocation-aware predictor evidence audit

- The private data-quality audit now shares the collector's event-kind contract,
  so queue-relocation and validated tie-break shadow receipts are counted instead
  of being falsely labelled invalid.
- Proven pre-dispatch destination changes are separated from unexplained worker
  mismatches. Relocated requests still produce no ordinary decision-node training
  label, and the live/offline feature builder now retires their stale job state.

## Later-evidence attribution reconciliation

- A separate read-only audit can now revisit historical clock-overlap
  abstentions after every candidate request has finished. It upgrades the audit
  view only for one exact prompt/cache usage match with no competing engine
  start; incomplete coverage, missing usage and collisions still abstain.
- The recorded rows remain immutable and are reported beside the reconciled
  view. Metric and gateway reads are regular-file-only and bounded to 32 MiB per
  source file; identifiers and paths never enter output.

## Local-log process-epoch attribution

- Timing records from a same-host stock DS4 log now inherit the bounded digest of
  the latest preceding `listening on` marker. This makes Mac request attribution
  usable without retaining the endpoint, raw line, prompt or file identity.
- Inheritance is ordered by byte position and file identity. A record before the
  marker or after rotation without a new marker remains epochless and abstains;
  DSG never carries an old process identity into a new file.

## Four-path cache-continuity shadow contract

- A pure comparator now ranks wait-hot, local-restore, remote-acquisition and
  cold-prefill critical paths from explicitly labelled numerical evidence. It
  uses `max(wait, transfer)` only when staging overlap is independently verified;
  otherwise remote acquisition is serial.
- Unknown evidence blocks a preferred path. Proven absence, incompatibility or
  protocol unavailability can exclude one. Snapshot absence requires a fresh,
  uncapped inventory with no rejected cache-shaped files.
- Inputs reject fields outside a fixed allowlist, outputs omit snapshot
  references, and the module has no routing, model, filesystem or cache-movement
  authority. Live request identity and remote transfer remain future gates.

## Privacy-safe cache inventory foundation

- An opt-in local/mounted-directory scanner now inventories stock DS4 disk-KV
  compatibility metadata by reading exactly the 52 bytes before verbatim prompt
  text. It rejects symlinks, special files, malformed/truncated headers and scans
  at most 4,096 cache-shaped files once per minute.
- Prompt-derived SHA-1 filenames never leave the scanner. A private persistent
  installation key produces comparable HMAC pseudonyms internally; diagnostics
  expose only aggregate cohorts, counts, byte totals and maximum token coverage.
- Compatibility mirrors DS4's bounded model/weights/quant/context header gates
  and abstains on legacy zero weight fingerprints. No cache is loaded, copied,
  deleted, rewritten or used for routing.

## Worker credential boundary

- DSG's bearer credential now terminates at the gateway instead of being
  forwarded with inference requests to stock DS4 workers. Model-list and health
  traffic already crossed the worker boundary without that credential.
- The supported contract is now explicit: workers are unauthenticated stock DS4
  endpoints protected by loopback or host-key-verified SSH. A regression covers
  startup probes, proxied model metadata and inference requests.

## Gate Genie hardening suggestions

- Genie can now turn a deterministic, privacy-bounded failure envelope into a
  developer-facing hardening hypothesis. Code—not the model—selects the candidate
  class, fleet/worker scope, allowlisted reason, evidence time and continuity
  outcome. Prompts, responses, images, sessions and arbitrary log prose are absent.
- The parser accepts at most three notes and only for exact offered candidate IDs.
  The private opt-in notebook deduplicates by failure signature, records revisions
  and grants no routing, shell, restart, server-edit or self-modification authority.
  A notebook failure does not block Genie reviews, routing or inference.
- A dense expandable panel above fleet status presents suggestions newest-first.
  With memory disabled, report-local suggestions are clearly marked ephemeral.

## Proof-gated, agent-driven visual continuation

- After DS4 proves a Chat Completions request exceeds its 16-image limit, DSG now
  chooses no images. It withholds all visuals from one transient recovery call,
  gives the model the exact failure and limits, and lets the agent decide whether
  to select frames, build a contact sheet, compact or ask the user. A proven GIF
  follows the same pattern with only the unsupported GIF withheld. Pi, Hermes and
  other OpenAI-compatible clients receive the model's real response/tool calls
  instead of stopping on a successful synthetic guidance turn.
- The client's stored conversation is untouched; text, roles, tools, reasoning,
  output limits and unrelated request fields are preserved. The model is told not
  to claim it saw withheld media. A second rejection becomes guidance and cannot
  loop. Ambiguous failures remain non-replayable.

## Safari icon cache bust

- The dashboard now advertises explicit versioned favicon, Apple touch-icon and
  Safari pinned-tab routes, including `shortcut icon`, so an old numeric localhost
  fallback is not reused as DSG's identity.

## Bounded attribution-audit file handling

- The public attribution audit now opens each evidence file once with no-follow
  semantics, verifies the opened descriptor is a regular file and reads from that
  same descriptor. A same-user path swap can no longer redirect a bounded audit
  after its file check.
- Programmatic callers now receive the same fixed file-count and byte ceilings as
  the command-line interface; invalid bounds fail closed instead of being silently
  clamped.

## Attribution evidence yield

- A bounded read-only audit now deduplicates final request-to-engine attribution
  revisions across recent metric files and reports corroboration, pending starts
  and fixed abstention causes per configured server. Output contains no request or
  sample IDs, prompts, responses, paths or credentials.
- The dashboard reports the same resolved-start denominator, and Gate Genie sees
  only a sanitized per-server summary. Corroboration remains shadow evidence—not
  protocol identity, a cache-hit verdict or routing authority.

## Curated public work log

- [WORKLOG.md](WORKLOG.md) now summarizes meaningful capability and reliability
  milestones in plain English. The changelog remains the detailed technical
  record; Git history remains exact; the roadmap remains forward-looking.

## Compact control room

- Fleet capacity, availability, queue depth, hourly output and the Gate Genie
  ticker now share one dense overview instead of three stacked headline panels.
- An explicit gear opens server management; the recommended DGX Spark profile is
  kept with those controls rather than occupying the live fleet view.
- Server cards use whole-token rates, aligned fixed-height charts, a compact ETA
  badge and folded cache/session evidence. The detailed evidence remains one click
  away and stays open across dashboard polls.
- The ticker keeps Genie-authored evidence and recommendations while removing its
  redundant visible heading, status label, pause button and explanatory copy.

## Deterministic GIF guidance

- DS4's misleading `invalid JSON request` response is intercepted only when DSG
  independently parses a valid Chat Completions request and verifies a typed
  GIF87a/GIF89a data URI. DSG does not convert, omit or retry the GIF. It returns
  a completed assistant turn asking for selected frames from the GIF as PNGs, so
  Pi remains alive and the user chooses which animation evidence matters.
- Unrelated generic JSON errors remain byte-for-byte upstream errors. The fixed
  GIF response works in streaming and non-streaming Chat Completions and does not
  depend on an image converter.
- DS4's exact 16-image rejection is proof-gated. The newer visual-continuation
  behavior above supersedes this initial guidance-only implementation.

## Gate Genie review lifecycle receipts

- The five-minute automatic review cadence now begins when the prior review
  finishes. A slow local reasoning pass can no longer trigger an immediate
  back-to-back review loop and leave Genie permanently busy.
- Status retains eight sanitized dedicated/pool attempt receipts and a bounded
  consecutive-failure count. The UI can distinguish completion, cancellation,
  timeout, transport/HTTP failure, invalid output and budget exhaustion without
  exposing endpoints, credentials, prompts, responses or raw errors.

## Visible cache-evidence health

- The compact cache-cost section now reports process-epoch coverage and recent
  request/engine correlation outcomes, including leading abstention reasons.
  It keeps corroborated candidates distinct from protocol proof and cache-hit
  verdicts, and it does not occupy headline dashboard space.

## Bounded local-log process epochs

- File-backed stock DS4 telemetry can now derive a bounded process epoch from
  the latest timestamped listen marker, file identity and byte location. This
  gives local Mac servers the same fail-closed cache-span boundary used by the
  systemd observer without editing DS4 or retaining the endpoint/raw log line.
- Startup scans are capped at the latest 8 MiB. Missing or older markers remain
  unknown; the local marker is explicitly weaker than a systemd invocation ID.

## Conservative attribution overlap resolution

- Request-to-engine shadow attribution now waits for every clock-overlapped
  gateway request to finish and uses the directly reported prompt/cache token
  tuple only when it identifies exactly one request. This resolves back-to-back
  gateway windows blurred by bounded clock tolerance without pretending DS4
  echoes a protocol request ID.
- Zero matching tuples, duplicate matches, missing usage, open requests and
  missing backend epochs still abstain. The evidence remains diagnostic only and
  grants no routing or recovery authority.

## Observed handover outcomes

- Analytics now joins an applied pre-dispatch handover to its actual destination
  dispatch and finish. It reports wait already paid, additional destination wait,
  successful service time and reported cache reuse without inventing the
  unobserved no-move outcome.
- Relocated requests remain excluded from ordinary decision-node predictor labels.
  Operator, scheduler and Gate Genie actors are all preserved by the bounded
  evidence allowlist; previously Genie-initiated handovers were omitted.

## Predictor artifact rejection diagnostics

- Predictor status now reports bounded rejection categories instead of only an
  unexplained count. Newly trained artifacts retain the exact category in their
  private failure record while the last working predictor remains unchanged.

## Accurate Gate Genie provider deadline

- The dashboard now displays the actual remaining provider allowance instead of
  formatting a future deadline as an elapsed timestamp. Manual questions still
  preempt routine reviews without shortening the two-hour inference allowance.

## Explicit queue-visibility boundary

- The headline now says `WAITING IN DSG`, and its visible summaries repeat that
  scope. DSG counts core and Continuity Door queues; work still held inside Pi,
  Hermes or another client has not reached the gateway and is not observable.

## Traceable manual routing controls

- Manual pause/resume now retains a bounded timestamped control-channel receipt
  and shows the latest source path in the server routing tooltip. The label is
  explicitly a same-user client path, not a claim about human identity.

## Read-only worker-registry drift detection

- Doctor now compares workers declared in private config with the authoritative
  durable registry and reports missing workers or changed endpoint/recovery
  bindings without printing private route names or changing live state.

## Visible recovery identity drift

- Recovery status now reports a changed enrolled service identity/profile even
  while that worker still has active or queued work. Previously the transient
  `wait_for_admitted_work` gate could hide the durable re-enrollment requirement
  until the queue became empty.
- Execution remains fail-closed: changed binaries, launchers, environments,
  declared profile files or systemd units still require deliberate enrollment
  and a new canary. No worker is restarted or trusted automatically.

## Complete known-backlog headline

- The dashboard's `WAITING` total now includes both requests admitted to the
  gateway core and requests held safely at the Continuity Door during a planned
  core replacement. Previously the Door's queue was shown only in its own panel,
  so the fleet headline could misleadingly report zero while clients were parked.
- Hover text and the fleet summary identify the two DSG-owned components and
  state the visibility boundary: work still queued inside Pi, Hermes or another
  client has not reached DSG and cannot be counted by the gateway.

## Versioned XGBoost V3 evidence contract

- A separately versioned V3 feature builder now supplies XGBoost with the
  admission/cache clocks, early client counters, bounded request shape, prior
  session history, semantic projections and live progress that DSG already
  observes. V2 remains byte-compatible and continues serving any validated
  incumbent while V3 earns independent evidence.
- The trainer cross-validates bounded feature blocks and 16/64/128 trees instead
  of forcing every noisy signal into one model. Candidate reports expose all
  feature coverage and winning-tree split usage; unavailable historical fields
  remain explicit zero coverage rather than invented values.
- Python/JavaScript parity now rounds split thresholds to XGBoost's float32
  representation. A regression test covers the exact-boundary case that had
  correctly failed candidate loading but obscured an otherwise valid artifact.
- For genuinely new or unaffined work only, a validated remaining-time forecast
  may break an exact deterministic active-plus-queue load tie. Missing, stale or
  experimental evidence abstains; established session homes and freer servers
  are never overridden. Receipts say whether a comparison was applied.

## Core-owned affinity wait escape

- A healthy, completely idle server no longer depends on the dashboard/Genie to
  receive mature pre-dispatch overflow. Established sessions retain a five-minute
  warm-home first-refusal window by default; the core then moves the oldest safe
  queue head with the original socket/deadline and a durable ownership commit.
- Same-session overlap, dispatch, pause, quarantine, shutdown and persistence
  checks remain fail-closed. Strict-affinity installations can disable the escape
  explicitly, and status reports the effective threshold and reason.

## Exact stopped-service recovery (opt-in)

- The existing systemd-user recovery adapter can now optionally start an exact
  loaded-but-stopped DS4 service. This power is off unless private enrollment sets
  `start_stopped:true` with the inspected static service-profile hash; registering,
  pausing or resuming a worker does not grant it.
- DSG requires a stable stopped epoch, failed readiness, no admitted work, no
  operator pause, one action per epoch and the existing fleet/cooldown bounds. It
  then rechecks the exact machine/unit/binary/profile identity and performs the
  normal model/context/generation/two-prefix cache verification before readmission.
- Both journals persist intent before effect. Lost acknowledgments and controller
  restarts reconcile without repeating `start`; UI receipts distinguish start from
  restart. Existing live-profile hashes and restart-only deployments remain compatible.
- Coverage is synthetic until an operator runs the documented drained-worker canary
  for a particular installation. No live fleet or DS4 model settings are changed by
  this source release.

## Patient Gate Genie provider deadline

- Gate Genie's dedicated-provider and pool-fallback deadlines are now two hours by
  default. Long-context local reasoning no longer falls through after two minutes
  or dies three minutes into its fallback.
- The local UI reports the active provider, elapsed time and remaining provider
  deadline while a manual question or scheduled review is running.
- Explicit endpoint deadlines remain bounded to 24 hours. This changes Genie
  observation only; gateway queues, model requests and DS4 settings are untouched.

## Verified replacement readmission

- A quarantined enrolled DS4 service that has already been replaced by its service
  manager can now be verified and readmitted automatically even when the original
  quarantine was repeated transport/stream failure rather than a CUDA signature.
- The replacement must be a newer exact machine/profile instance with its listener
  open, no admitted work and successful cold-to-warm verification. DSG issues no
  restart command in this path; unchanged, stopped or unreachable instances stay
  isolated.
- Existing remote registrations can update only their bounded SSH fallback list
  through the local UI or CLI without remove/re-add, inference interruption or
  model changes. Optimistic concurrency rejects stale edits; the tunnel supervisor
  reads the latest durable list on its next reconnect.

## Resilient enrolled SSH routes

- A remote DS4 server may now have up to four additional OpenSSH aliases. The
  tunnel supervisor rotates to the next verified alias only after a route exits;
  the guarded systemd recovery adapter uses the same ordered set.
- Aliases remain private configuration. DSG accepts neither SSH options nor
  commands, prevents overlapping endpoint registrations, and exports only the
  bounded route count and transport state—not aliases, addresses or stderr.
- The local worker form and CLI accept optional fallbacks. Existing single-alias
  configurations are unchanged. Compatibility enrollment allows 15 seconds per
  configured route unless the operator supplied an explicit deadline.

## Three-state server activity view

- Per-server history now uses three operational bands only: blue prefill, green
  decode/generation (including thinking-token generation), and red idle/off.
  Unknown telemetry remains an unlabelled dark gap rather than a fabricated
  state; the separate server verdict still distinguishes healthy idle, paused
  and unavailable machines.

## Layered worker-failure evidence

- Gateway status now reports a sanitized management-path state separately from
  DS4 readiness: local, connecting, SSH process active, model-probe verified,
  retrying or failed. DNS, host-key, authentication, timeout, refusal, route and
  reset failures remain bounded reason classes; raw SSH text and endpoints are
  excluded from dashboard and Genie evidence.
- The recovery adapter preserves the same bounded failure classes instead of
  collapsing every transport/helper failure into one vague status. These facts
  improve diagnosis only and grant no new restart authority.
- An unavailable/paused server card no longer repeats the same state in both its
  verdict and phase badge. The verdict tooltip gives the actionable layer detail.

## Explainable handovers and passive remaining-time evidence (historical precursor)

- Queued-handover status now states the exact safety reason when no relocation is
  offered, without exposing prompts, request bodies or raw session identifiers.
- This release first added the fail-closed shadow comparator. The newer V3 entry
  above documents its narrow active successor; missing, stale or experimental
  forecasts still produce an explicit abstention.

## Queued-work shadow evidence

- Opt-in per-worker idle/active clocks, session recency and intervening requests.
- Admission/free-worker shadow comparisons using a bounded, explicitly unvalidated
  historical baseline; unknown evidence stays unknown. No routing/model changes.
- Repeated comparison events are isolated from XGB completion labels. No new
  encoder or embeddings are implied. See [shadow setup](docs/routing-shadow.md).

## Unreleased

- Stable Continuity Door on the public DSG port: planned core restarts hold new
  body streams unread, preserve existing proxied responses, start the replacement
  behind a worker-probe barrier, and release only after a fresh health check. The
  core is loopback-only; the Door never spools or replays request bodies. Lifecycle,
  cancellation, startup-race and real Pi transport tests cover the boundary.
- Gate Genie chat now accepts immediately, yields a replaceable scheduled review
  to a human question, and keeps evidence-gated action reviews non-preemptible.
  Dedicated and pool attempts have bounded deadlines; an explicit dedicated
  timeout permits the same one-shot, unpinned pool fallback as a provider error.
  Status exposes receipts and deadlines without endpoint or credential details.

- Narrow DS4 JPEG compatibility protection for Chat Completions: DSG first
  forwards the request unchanged, then only on DS4's exact pre-generation JPEG
  rejection converts typed inline JPEG data to PNG and retries once on the same
  server. If safe repair is unavailable or rejected, DSG completes the turn with
  practical PNG/WebP/RGB-JPEG resend guidance instead of terminating the client
  session. Ambiguous/partial generations are never replayed, raw images are not
  logged, and the UI exposes the protection and its bounded outcomes.
- A configured Gate Genie now starts enabled by default; recovery and predictor
  mutation remain separately gated. Server cards add evidence-based verdicts,
  oldest-wait backlog context, stale-measurement treatment and clearer answering/
  prompt-reading labels. The dashboard also adds a compact fleet summary, recent-
  request filters and first-server onboarding without inventing incomparable
  performance rankings.

- Safe queued ownership handover: untouched first/unaffined requests automatically
  take a newly free DS4 server without replaying the body or resetting the client
  deadline. Existing affinity-bound sessions require an exact operator-confirmed
  offer because destination cache locality is unknown. Durable-write failure leaves
  the original queue/client intact; private receipts and UI controls are included.
- Gate Genie now tries its dedicated provider first and, after an explicit failure,
  may borrow one unpinned normal DSG inference slot. Pool calls receive the bounded
  live fleet briefing but not the private Genie notebook. A failed/partial attempt
  cannot contribute prose or actions to the accepted report.

- Gateway-side patient waiting across pre-dispatch worker outages, retaining
  original deadlines, conversation order and queued homes. No dispatched replay.
  HTTP 102 keep-alives, bounded waiting, cancellation, visible recovery-wait counts
  and Genie evidence; guarded worker verification is not blocked by parked uploads.
  DSG-owned API errors start `DSG Report:`; upstream DS4 error bodies are unchanged.
  Native Pi agent/tool-loop and fault-injection tests cover continuation and scope.

- Optional v2 XGB lifecycle: shared causal offline/live features, missing-history
  and measured hardware priors, prior output/thinking ratios, embedding-aware
  updates and elapsed/phase-conditioned remaining forecasts. Cross-validated tree
  count/features, native JS/Python parity, immutable bundles, future-shadow gates,
  automatic rollback and separately armed new-session placement.
- GG can request offered bounded training or measured-regression rollback, never
  edit gates or promote a model itself. Analytics separates versions/stages and
  exposes independent training, validation and placement switches with receipts.
  First-request history is missing, not filled with an invented prior duration.

- Single-checkout installation with ignored private config/runtime, non-overwriting
  setup, read-only doctor and explicit macOS gateway/dashboard login services.
  All entry points share config resolution, including paths with spaces/symlinks.
  Service status accepts a controls-enabled dashboard; busy stops require an
  explicit interruption flag, and dashboard restarts archive Genie reports.
  A clean-checkout integration test covers setup, UI registration, exact request
  forwarding, durable worker state and exclusion of private files from Git.

- Measured cache-cost calculator in Analytics: per-server disk-load/prefill
  components, bounded comparable samples, explicit unknowns and no cache-existence
  claim. It does not change routing or operate caches.
- Opt-in pinned local CPU embeddings of bounded visible conversation slices,
  private vectors with feature-availability timestamps, and correlated 30-second
  semantic progress records. Encoder failure/overload leaves forwarding intact;
  collection status is visible and the existing charts remain historical baselines.
- Offline XGB can select tree count using forward-time/session-disjoint folds
  inside training only; the final holdout stays separate. No live model promotion.

- Color each Genie health-wire item by its own structured severity: good, info,
  warning or critical. Add text labels and preserve pause, stale-evidence and
  reduced-motion behavior; severity never grants recovery authority.

- Add compact read-only Analytics: frozen admission forecasts versus actual queue
  and server durations, equal-axis chart, per-server filters, coverage/error,
  bounded evidence tailing and explicit unknown/censored outcomes. No live XGB
  or routing changes; model/data next steps are documented separately.

- Generalized recovery/profile/incident and predictor documentation; detailed
  operational records stay private. Exact recommended settings and known risks
  remain documented. Current-tree cleanup does not erase previous Git history.
- Optional staged-content pre-commit privacy hook, non-destructive installer,
  deployment-narrative heuristics and real-Git regression tests in CI. Human
  review is still required, particularly for prose, images and prior history.

- Recovery worker rows show current state separately from historical action
  receipts; resuming after a successful canary no longer looks like a stale pause.

- Logo-derived SVG/ICO/PNG favicons, Apple touch icon and a transparent monochrome
  Safari pinned-tab mask. Versioned SVG/PNG URLs, frozen asset-bundle serving and
  icon format/dimension tests. Main logo and model settings unchanged.

- Opt-in systemd-user DS4 recovery: exact-service enrollment, current-invocation
  fatal CUDA evidence, one fleet action, per-instance idempotency and cooldown,
  durable intent/receipts, lost-ack reconciliation, generation/two-session cache
  verification, operator pause precedence, UI automatic/recover/recheck controls.
  GG and the deterministic detector share the same guarded action runner. No
  model setting changes; launchd/container adapters remain unimplemented.

- Genie-authored health ticker: structured observations and short recommendations
  from the existing review call, explicit evidence time and invalid/stale/changed
  state handling. Faster scrolling, wider gaps, pause and reduced-motion support.
  The ticker itself grants no operational powers and changes no model-server
  settings. Expanded reports remain readable across polling.
- Correct SSE completion classification for Chat Completions/Completions,
  Responses and Messages. Output-limited Responses are censored, not failed
  workers; explicit error terminals remain failures. Oversized unobservable
  endings are recorded as unknown, not falsely successful or quarantined.
- Bounded SSE observation skips whole oversized lines across chunks; suffixes
  cannot spoof a terminal event. Split UTF-8 is preserved and usage is numeric-only.
- Quarantined worker re-registration remains paused and retains its fault record;
  verified recovery is reachable without manually editing state. Operator clients
  use fresh control sockets across gateway restarts, without mutation retries.
- Persistent generation-failure quarantine, fresh generation-verified recovery,
  and sanitized fault evidence for diagnostics and Genie assessments.
- Opt-in numerical routing collector, fleet occupancy/activity timelines and
  Gate Genie chat with dedicated inference or explicitly selected pool fallback.
  Learning-based routing remains unimplemented; embeddings and recovery are
  separately opt-in features described above.
- Optional locked offline XGBoost fit/evaluate/save/reload package with separate
  machine identity/hardware-family features, leakage-aware chronological splits,
  artifact checksums, tests and documented production tree-count validation gate.
- Persistent pool-context UI control, the 262,144-token Spark deployment profile,
  and explicit runtime-fault caveats alongside historical capacity measurements.
- Updated operator guidance, maintenance review and prioritized delivery gates.
- Read-only local Mac engine-log telemetry: bounded tailing, timestamped decode/
  prefill/cache observations, rotation recovery and source-aware connectivity labels.
  Explicit private path mapping; no engine changes or raw-log exports.
- Published the current, pinned DGX Spark recommendation with exact launch settings,
  artifact hashes, measured acceptance and known limits; linked it from the dashboard.
  Documentation only: no server or routing defaults changed.
- Consistent DS4-server UI terminology and explicit gateway-only concurrency,
  availability and cache-slot definitions for mixed hardware.
- Live worker registration/removal through an opt-in local UI and private CLI;
  checked registrations start paused and membership persists across restarts.
- Mixed Mac/Spark native context support without changing server settings;
  model-list metadata advertises the configured common pool guarantee.
- Absolute health-probe deadline and regression test for trickling responses;
  long inference-stream timeouts are unchanged.
- Per-worker requested-thinking indicator, with current/last-request distinction,
  explicit unknown/default states and allowlisted diagnostic metadata.
- Bounded passive request observation; byte-preservation, streaming upload,
  per-worker isolation and oversized vision-upload regression tests.
- Prominent credit and links to Antirez's original DwarfStar / DS4 project.
- Contributor and security-reporting guidance.
- Branded UI, owner-provided replaceable artwork and synthetic screenshots.
- Complete startup asset bundles and regression coverage for missing UI assets.
- Generic N-worker documentation and fixture-pool tests through 20 workers.

## 0.1.0 — 2026-09-02

- Initial durable session-affinity gateway with one active request per worker.
- FIFO waiting queues, cancellation propagation and no ambiguous automatic replay.
- Model/context health checks, SSH tunnel recovery and persisted worker drains.
- Read-only per-device timing/cache dashboard and sanitized diagnostic export.
- Local fixture tests, Linux/macOS CI and source-publication privacy checks.

Version labels describe source milestones, not certification of every DS4 build,
client or deployment. See the README for tested scope and operational limitations.
