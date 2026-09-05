# Current work plan

Reconciled 2026-09-05. This is the short active checklist; the
[roadmap](roadmap.md) retains detailed designs and historical milestones.
Source-complete, tested, deployed and proven useful are separate claims.
Private deployment receipts and measurements stay out of this public plan.

> A low-effort DS4 fleet that keeps agents working. Intelligence should make
> that dependable foundation better—not become another dependency that stalls it.

## Completed milestone: analytics people can understand

- [x] Separate question, method, checkpoint and exact model version. Explain the
  legacy history rule separately from XGB's saved reference rule.
- [x] Hold chart evidence while it is being studied. Refresh and version changes
  are explicit; disclose bounded selection, missing joins and every count's unit.
- [x] Separate live model use, predictive accuracy and measured routing benefit.
  Keep technical evidence and training controls expandable.
- [x] Cover no-data/no-model startup, outages, rotations and browser layout with
  isolated fixtures. Keep optional analytics independent of inference.
- [x] Complete release validation, refresh synthetic screenshots and record the
  dashboard-only deployment separately from unchanged core/model services.

## Next, in order

1. **Finish the hardening and efficiency pass.** Complete the outstanding
   attribution-audit indexing optimization with boundary/order/parity tests.
   Retain ambiguous-overlap and tied-revision abstentions. Check fresh ordinary
   traffic across process epochs; synthetic speed gains alone are not live proof.
   Continue focused lifecycle/privacy/retention checks rather than broad rewrites.
2. **Make cache misses actionable.** Replace the vague machine-card cache summary
   with expected cold work, RAM misses recovered from disk and evidence-backed
   lost prefix reuse. Show cost, recency, coverage and justified next checks;
   unknown cause/cost stays unknown. See the [cache-miss design](roadmap.md#planned-actionable-cache-misses-in-machine-cards).
3. **Make Genie suggestions useful to developers.** Reconcile repeated or
   contradictory transport labels, group incidents, identify already implemented
   safeguards, and mark resolved/superseded hypotheses. Require a specific
   observation, bounded proposed change and falsifiable acceptance test—not
   repeated generic retry advice. Preserve newest-first durable notes and the
   action ledger, including borrowed-endpoint receipts. Never retry ambiguous
   dispatched work merely because the provider went quiet.
4. **Improve forecast evidence before expanding authority.** Separate engine
   throughput from client-delivery timing; examine long/censored jobs, causal
   early features and sensor/semantic coverage. Score frozen future cohorts by
   worker, session novelty and tail, with matched checkpoints. Add reproducible
   durable study/cohort exports if the bounded recent panel is insufficient.
   Retain all original validation gates and deterministic fallbacks; report
   actual routing benefit separately. No experimental promotion is implied.
5. **Settle the gateway-only image-continuity contract.** The Pi image companion
   was withdrawn. Investigate a transparent outgoing visual window, explicit
   markers and agent-directed rereads/batching, without altering saved history.
   First test unchanged/appended/retired-image KV reuse on an isolated backend:
   changing the image prefix can force full prefill. Confirm real Pi continuation,
   not just an HTTP 200. The backend's 16-image check is confirmed; why that number
   is necessary remains an upstream research/possible PR question. Do not raise
   it or roll out trimming without the agreed cache/continuity tradeoff.
6. **Finish portable recovery enrollment and proof.** Add a per-worker guided
   checklist for inspection, exact authority, private enrollment, separate
   disruptive canary and certification/blockers. Generic launchd/retained-job
   source is not a certified Mac installation. Operator pauses, named maintenance
   and other agents' holds always win, including patched-but-idle workers.
   A real cold/warm recovery canary requires an exclusively drained, approved
   window and preserved exact launch definitions. See the [agent enrollment guide](agent-recovery-enrollment.md).
7. **Complete useful hardware coverage and workload planning.** RAM/GPU/power
   adapters and bounded sampling are implemented. Finish per-installation Mac
   power enrollment; report scope and missing coverage, never substitute TDP.
   Evaluate temperature/thermal pressure and throttling as optional bounded
   features, with documented raw retention/rollups and explicit unavailable
   values. Add an approximate fleet work-horizon estimate from active progress
   and queued requests, with uncertainty and coverage; it cannot predict future
   agent turns or the duration of an entire project.

## Later opt-ins, not implicit permission

- **[Priority Lens](roadmap.md#future-opt-in-priority-lens):** persistent consent
  to bounded request snippets, explainable prioritization and user feedback.
  Protect privacy/fairness; core scheduling must survive Genie unavailability.
- **[Session Rescue](roadmap.md#planned-opt-in-session-rescue):** enrolled Pi
  observation first, then supported client-owned continuation. A routine “shall
  I continue the authorized work?” may qualify; missing human decisions, new
  authority, active tools and unknown execution state do not. Agent Watch already
  observes; automatic session control and a packaged Hermes adapter remain work.
- **[Four cache-source alternatives](cache-continuity-shadow.md):** comparison
  logic exists, but live use needs exact rendered-prefix identity, compatible
  inventory, an approved transfer/import protocol and measured components.
  No copying/deleting caches or invented alternative-route speedups.

## Keep closed unless a regression is found

The compact tabbed dashboard, far-right Settings, simplified labels, phase
colours, compressed chart separators, persisted fleet-record scales, favicon,
fleet speed/energy foundations, durable Genie ledger, scoped agent holds,
MIT license, work log and tagline already have implementation milestones.
Keep docs, synthetic screenshots and tests synchronized as affected areas change;
do not reopen all those tasks as unfinished redesigns.

## Release discipline

For each milestone: reproduce → preserve a timestamped backup → make the scoped
change → run regressions and direct checks → update docs/work log → commit/push
and inspect CI → deploy only the affected service in an authorized window.
Do not discard unrelated unfinished work to manufacture a clean Git status.
Model servers, cache capacity, context, output, concurrency and maintenance intent
are not changed by a dashboard release. Record remaining uncertainty explicitly.
