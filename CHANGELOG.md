# Changelog

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

## Explainable handovers and passive remaining-time evidence

- Queued-handover status now states the exact safety reason when no relocation is
  offered, without exposing prompts, request bodies or raw session identifiers.
- A fail-closed shadow comparator records whether fresh remaining-time evidence
  would change the deterministic equal-load fallback. It cannot affect routing;
  missing, stale or experimental forecasts produce an explicit abstention.

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
