# Dwarf Star Gate work log

This is the short, human-readable record of meaningful DSG progress. It answers
“what did we build, and why does it matter?” without reproducing every commit or
private deployment event.

For implementation detail, see the [changelog](CHANGELOG.md). For exact history,
see [Git commits](https://github.com/JordiPosthumus/dwarf-star-gate/commits/main/).
For unfinished work, see the [roadmap](docs/roadmap.md).

## Recent reliability and intelligence sprint — 2026-09-03 to 2026-09-04

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
