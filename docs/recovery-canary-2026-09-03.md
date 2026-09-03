# Live recovery canaries — 2026-09-03 UTC

Deployment evidence, not a new default for other installations. Both enrolled
native DGX Spark services passed the operator-only canary in
[bounded worker recovery](worker-recovery.md). The third, Mac-based inference
worker remained available and was not enrolled for automatic service recovery.

Recovery implementation: `88a9477`. The subsequent `bd26950` display correction
separates a worker's current state from its historical action receipt. The
logo-derived Safari/browser icons were published in `b2fa280`.

## What was exercised

- Drained the gateway and waited for existing requests to finish before cutover.
  No admitted request was interrupted by this rollout.
- Drained and restarted each Spark in turn through its enrolled recovery helper.
  The other Spark and Mac stayed available during each canary.
- Verified the replacement service invocation, exact enrolled machine/profile,
  executable/listener ownership, and unchanged model/context advertisement.
- Both services logged successful saves of both resident caches during shutdown.
  No model, launcher, environment, disk-cache setting or disk-cache file was
  replaced or deleted by DSG.
- Ran two isolated synthetic cold prompts, then both warm continuations per
  server. Required exact answers, `finish_reason: stop` and numerical cache usage.
  The canary deliberately left each worker paused; the operator then resumed it.

## Measured results

These are approximately 2,200-token health checks, **not workload benchmarks**.
Elapsed time covers the individual API request, not only decode.

| Server | Request | Prompt tokens | Reused tokens | Elapsed |
| --- | --- | ---: | ---: | ---: |
| First Spark | Cold A | 2,203 | 0 | 10.514 s |
| First Spark | Cold B | 2,203 | 0 | 5.322 s |
| First Spark | Warm A | 2,218 | 2,206 | 0.430 s |
| First Spark | Warm B | 2,218 | 2,206 | 0.434 s |
| Second Spark | Cold A | 2,206 | 0 | 10.875 s |
| Second Spark | Cold B | 2,206 | 0 | 3.204 s |
| Second Spark | Warm A | 2,221 | 2,209 | 0.406 s |
| Second Spark | Warm B | 2,221 | 2,209 | 0.465 s |

First verification completed at 01:21:11 UTC; second at 01:24:53 UTC.
Native arguments on both remained context/output **262,144**, two resident
sessions, one active request, prefill chunk 2,048, continued-cache interval 16,384,
disk-cache budget 349,525 MiB and cold-cache maximum 262,144. Vision assets and
weight-warming settings were preserved. The gateway's 360,000,000 ms request
timeout remained unchanged. Synthetic checks alone use small output budgets and
disabled thinking; ordinary clients retain their own requested reasoning/limits.

## Cutover checks

After both canaries, automatic recovery was explicitly enabled for these two
enrollments. A second idle gateway restart activated the display correction and
proved that the policy, two action receipts, session affinity and unpaused roster
survived. All three workers and the public model list advertised 262,144 context.
A real Chat Completions request through DSG returned the exact expected marker.

The two canaries are operator actions, not claims that GG independently diagnosed
or recovered a live fault. Automatic mode authorizes GG's structured requests and
the deterministic fatal-fault watcher through the same guarded runner. It stays
off by default in the public configuration. Macs still need manual recovery.
Canaries count toward the existing 30-minute per-worker cooldown; enabling the
policy does not bypass that interval.

The current-state correction passed 130 JavaScript tests and four Python adapter
tests. The icon and initial recovery commits also passed GitHub CI on macOS and
Linux. See the workflow result for the exact commit being deployed.

## What remains unproven

This does not inject a CUDA fault, prove fault-triggered recovery end-to-end on
real hardware, certify 262k long-context/vision stability, measure disk-restore
performance, or repair an already failed client stream. The known accelerator
fault still requires diagnosis. Successful small cache reuse must not be
presented as a kernel fix or proof of every cache tier.

Next priorities remain request-to-engine attribution with backend process
instances, trustworthy cache-health evidence and local embedding collection,
followed by validated XGB prediction and shadow-tested overflow routing. See the
[roadmap](roadmap.md); none of those future capabilities is implied by this
recovery deployment.
