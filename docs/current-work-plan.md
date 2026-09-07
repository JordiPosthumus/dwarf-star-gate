# Current work plan

Reconciled 2026-09-07. The current scope is to finish and document the simplified
DSG system. This replaces the previous broad milestone list; older roadmaps and
experiments are historical context, not an instruction to resume them.

The authoritative overview is [The simplified DSG system](simplified-system.md).
Private deployment receipts and measurements stay outside this public repository.

## Simplification release

- [x] Retire XGB, embeddings, training, prediction, promotion and model data.
- [x] Retire Priority Lens classification, preferences and weighted scheduling.
- [x] Retire Proactive Resume and its optional Pi continuation adapters.
- [x] Keep read-only Current Jobs with bounded private previews, state,
  worker placement and timing.
- [x] Preserve Door continuity, ordinary FIFO, affinity, ownership/holds,
  safe queued handover and certified pre-dispatch retry.
- [x] Keep measured cache/prefill/decode evidence, power and energy visibility,
  temperature telemetry, Genie explanations and existing enrolled recovery.
- [x] Retire speculative cache comparison and calibration preflight; document
  the remaining load-based placement, affinity and safe queued handover.
- [x] Update the README, feature documentation, roadmap, changelog, work log,
  synthetic screenshots and this checklist for the reduced scope.
- [x] Pass gateway/dashboard, continuity, browser, syntax and privacy checks.

The power and fleet-energy requirements from the earlier draft are retained in
the implemented hardware visibility: measured watts and freshness, an explicit
accumulation period, included workers, missing coverage and measurement scope.
Do not substitute rated power or claim GPU-only measurements cover a whole host.

## Completion boundary

Publish the reviewed source and documentation; activate only the changed gateway
and dashboard after their work is idle; verify the live interface and retained
worker/settings/cache continuity; record deployment evidence privately. This
release does not create a new open-ended development goal.

Future experiments, additional client automation, cache transfer or deliberate
calibration require a new decision. No retired milestone remains on the active
checklist. Preserve unrelated work and existing operational history.
