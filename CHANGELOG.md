# Changelog

## Queued-work shadow evidence

- Opt-in per-worker idle/active clocks, session recency and intervening requests.
- Admission/free-worker shadow comparisons using a bounded, explicitly unvalidated
  historical baseline; unknown evidence stays unknown. No routing/model changes.
- Repeated comparison events are isolated from XGB completion labels. No new
  encoder or embeddings are implied. See [shadow setup](docs/routing-shadow.md).

## Unreleased

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
  No embeddings or learning-based routing yet; recovery is separately opt-in.
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
