# The simplified DSG system

DSG provides one local entry point to compatible DS4 servers. Its job is to keep
requests attached to the right worker, preserve continuity during gateway
maintenance, and explain observed fleet activity. DS4 owns model execution and
KV caches; clients own their conversations, tools and decisions to start turns.

## What remains

| Component | Responsibility |
| --- | --- |
| Continuity Door | Keeps the client-facing port available during planned gateway-core maintenance; holds new arrivals while admitted work drains. |
| Gateway | Checks compatibility, keeps conversation affinity and ordinary FIFO queue order, and respects health, ownership, pauses and maintenance holds. |
| Safe queued handover | Can move eligible work before dispatch under the existing independent checks. It does not replay already-dispatched requests or transfer KV files. |
| Current Jobs | Shows observed request previews, state, worker placement and waiting/running times in a read-only local view. |
| Operational evidence | Records request outcomes, reported cache reuse, observed cache misses/restores, measured prefill/decode rates and attribution uncertainty. |
| Hardware telemetry | Shows available memory, activity, measured power, accumulated energy and temperature, with freshness and measurement-scope labels. |
| Gate Genie | Explains fleet evidence, maintains its existing private notebook/action history, and requests only independently validated, already-enrolled actions. |
| Scoped controls and recovery | Preserve operator pauses, agent ownership, named maintenance locks and separately enrolled recovery policies. |
| Optional client continuity / Agent Watch | Support certified non-dispatch waiting and advisory client status without submitting a new user turn. |

Genie can select compatible free pool capacity for a new review. Provider
fallback requires proven non-dispatch; an ambiguous dispatched failure is not
permission to replay it. Normal request dispatch never waits for Genie advice.

## Current Jobs is observational

The local dashboard reads `GET /api/current-jobs`, backed by the gateway's local
control-socket `GET /current-jobs`. The endpoint has no mutation actions. General
inference status, diagnostics, request journals and Genie prompts exclude these
previews.

The gateway extracts a supported user-text excerpt from the original request and
keeps a whitespace-normalized preview of at most 160 Unicode characters, plus an
ellipsis when truncated. It clears that preview when the request ends or after
ten minutes. System messages, assistant text, tool output and thinking are not
used as preview text. Short continuation replies may include earlier user-task
context from the same request body. Unsupported or unavailable text stays
unidentified; the dashboard does not invent a title.

Queued inspection retains the existing shared 64 MiB buffering allowance and
8 MiB per-request inspection bound. These are observation limits, not request,
context or output limits: larger and incomplete uploads are forwarded intact.
No classifier, priority score or separate model call is involved.

## What was retired

- **XGB and embeddings:** model training, learned prediction/placement, promotion,
  feature encoders and their model/data artifacts were removed.
- **Priority Lens:** manual and automatic priorities, saved preferences,
  correction proposals, weighted selection, aging policy, classification calls
  and Pi intent-sharing adapters were removed. Current Jobs remains.
- **Proactive Resume / Session Rescue:** optional continuation review,
  enrollment and controller adapters were removed. Agent Watch remains advisory.

Historical designs and source remain in Git history. Private deployment backups
and operational receipts are retained separately from published documentation.

## Cache comparison and calibration: retained, inactive research

The four-path cache comparator estimates hypothetical completion costs for
waiting at a warm worker, restoring a local disk cache, acquiring a compatible
remote cache, or rebuilding through cold prefill. It is a shadow comparison:
it does not route requests, read or transfer caches, replay work or call a model.

Calibration would deliberately measure those component costs with extra work.
The current implementation is only a read-only preflight. There is no verified
non-displacing calibration runner, so it reports that execution is unavailable
and skipped. No new calibration experiment or cache-transfer capability is
activated by this simplification.

Measurements from ordinary requests remain useful independently of both:
reported cache reuse, observed misses, disk-load spans and prefill/decode speed.
Unknown cause or missing coverage stays unknown. See the
[cache continuity comparison](cache-continuity-shadow.md) and
[cache audit](cache-continuity-audit.md).

## Operation and validation

Changing dashboard or gateway source does not authorize a DS4 restart, cache
clear or model-setting change. Preserve a timestamped source/configuration
backup, drain admitted gateway work through the Door, update only affected
services, and verify effective settings and worker identity afterward. Wait for
Genie work to finish before replacing its dashboard process.

The retirement release passes the gateway/dashboard, continuity, syntax,
publication-privacy and synthetic browser checks. Gateway fixtures verify FIFO
order, exact body forwarding, large/partial uploads and preview privacy. Browser
checks cover the read-only Jobs table, retained fleet controls and narrow
layouts. Private live activation receipts remain outside Git.

See [setup](../README.md), [service commands](../README.md#quick-start),
[worker recovery](worker-recovery.md), [Agent Watch](agent-watch.md) and the
[closed simplification checklist](current-work-plan.md).
