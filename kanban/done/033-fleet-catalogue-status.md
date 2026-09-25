# Reconcile the fleet catalogue and report actual machine use

Pending, after #030. Done means every configured model maps clearly to its
worker/endpoint, physical machine(s), model routes and existing launch scripts.
The dashboard and Genie consume the same facts; a two-Spark model is one serving
endpoint occupying two machines. Use existing records and a small explicit mapping,
not a new registry service or database.

- [ ] Inventory current configuration, durable worker state, aliases and enrolled
  scripts; explain precedence and flag disagreements. Inspect before changing.
- [ ] Reconcile stale/duplicate references with evidence. Preserve intentional
  stopped models, direct client routes and alternative recipes; no automatic deletion.
- [ ] Distinguish configured/stopped, loading, serving LLM, serving video/music,
  failed, and unknown/stale observation. An offline LLM endpoint alone does not
  mean its physical machine is down. Show source/time and useful failure details.
- [ ] Active models appear first. Media cards show their actual workload/progress;
  historical LLM rates must not masquerade as current media activity.
- [ ] UI and Genie agree for a stopped model, a serving pair, and a media workload.
  Verify existing pool aliases and explicit routes still work after changes.

Reuse #030 controls. Coordinate media engine metadata with #004 and pair ownership
with #005; do not create competing lists. Record unresolved mismatches honestly.

## LANDED 2026-09-22 ~18:00 (commit 9d41363 + dashboard.mjs fix)
- `ds4-gateway/ui/fleet-catalogue.js`: pure module shared by dashboard UI and
  Genie (same function, same inputs → identical facts). Derives per-model state
  from existing records only: serving-llm, serving-media, engine-up (endpoint
  answers, gateway health unproven — may be loading), paused (routing pause,
  engine still up), engine-stopped (machine reachable via hardware agent),
  configured-stopped (enrolled scripts, not a gateway worker), failed
  (quarantined), unknown (endpoint down AND machine state unknown — an offline
  endpoint never proves the machine is down).
- Mapping: every enrolled power-script member → physical machine group(s),
  routes (from core model_routes), scripts, served_model, observation sources
  (endpoint telemetry / gateway probe / hardware agent) and times.
- Honest disagreement flags: routes to non-enlisted/routing-paused/unhealthy
  workers, gateway workers without enrolled scripts. No auto-repair.
- Active-first ordering (serving-llm → serving-media → engine-up → paused →
  engine-stopped → configured-stopped → failed → unknown), then id.
- UI: collapsible "Fleet catalogue — model to machine mapping" table on the
  fleet tab under the server cards, open when something serves; warnings listed.
- Genie: fleet power status evidence now carries the same catalogue (verified
  live: 8 entries, 10 warnings). UI + Genie read identical facts.
- Live verification (18:00): both GLM pairs serving-llm with machine pairs;
  glm53f-m3 paused (owner debugging, drained routing-only); ds41-m3 unknown;
  mimo-m3/qwen-image/ds41-sparks configured-stopped; spark1/spark2 dead-worker
  self-routes flagged; ds41-m3 unhealthy route flagged.
- Tests: fleet-catalogue.test.mjs 7/7; dashboard 98/98 (+2); suite 1081 pass /
  0 fail (1095 tests, 14 skipped).
- Deliberately NOT done: no deletion of stale entries (spark1/spark2 dead Qwen
  workers and their self-routes stay visible and flagged); no new registry —
  members come from the power-script enrollment, workers/routes from core.
## Maintenance-state correction

Verified 2026-09-24: maintenance locks, owned holds, and direct reservations now
exclude a worker from serving-LLM status and are distinguished from an operator
pause. Endpoint readiness is described only with current endpoint evidence.
The shared UI/Genie catalogue state is covered by regressions and native UI
validation. Intentional alternative/stopped entries remain.
