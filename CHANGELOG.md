# Changelog

## Unreleased

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
