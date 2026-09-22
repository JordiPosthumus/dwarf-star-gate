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
