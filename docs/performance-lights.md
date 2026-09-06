# Decode, Prefill and Cache hits

Each machine card has three compact, labelled indicators. Hover for evidence or
click to open an accessible dialog; the card does not grow, and polling does not
close the dialog. These are observations. They grant no routing, recovery,
restart, cache or model-setting authority. The existing fleet-speed gauges and
1h / 12h / 24h selector are unchanged.

## Decode and prefill comparisons

The dashboard reads up to eight daily numerical metric files to cover a rolling
seven days. The recent window is 30 minutes. Self-history excludes that recent
window; equivalent peers are compared separately over the recent window. A
supported self comparison does not depend on having peers. The worse supported
comparison sets the light, and its evidence names self, peers or both.

Speed is total token deltas divided by total active phase seconds, using DS4's
cumulative counters. Repeated samples are not averaged as independent speeds.
Decode includes thinking tokens and excludes prefill, queueing and idle. Prefill
uses only new-token processing: cold work, cached suffixes and suffixes after a
measured disk restore have separate cohorts. Disk-load duration is never added
to prefill duration. A restored prefix is not itself a fault.

Context is matched in power-of-two token bands; prefill also matches the
new-token suffix band. Each baseline cohort needs at least three requests and
60 active seconds. Matched recent evidence also needs three requests and
60 active seconds, covering at least 80% of recent active time. The reference
rate is weighted to the recent context mix, so a shift toward long contexts
cannot alone manufacture a slowdown. Bands are approximate workload matching,
not proof of identical prompts or computational work.

The defaults are 15% slowdown for amber and 30% for red. A slowdown must also
appear at the same severity in two disjoint ten-minute blocks, each containing
at least two requests and 20 active seconds. Re-reading one sample twice cannot
confirm a slowdown. Green means supported recent performance is within those
thresholds; it does not certify the server's overall health. An idle worker,
stale phase measurement (over 15 seconds), insufficient matching data or an
unready history reader is grey. Fresh direct engine work may be observed even
when no gateway request occupies a slot.

Without an explicit configuration identity, self comparisons are restricted to
the same backend process. Old process history remains stored but cannot silently
stand in for an unchanged build after a restart. Missing process/prompt evidence,
regressing counters and unresolved overlapping prompt starts exclude affected
intervals. The dialog reports these exclusions and limited historical coverage.
An unmatched start may be a telemetry gap; it is not proof of concurrent work.

## Optional configuration attestations

No hardware identity is inferred from a worker name. Existing numerical logs do
not establish model quantization, engine build and equivalent peer hardware.
Peer comparisons therefore remain unknown unless an operator supplies a complete
attestation in the private dashboard configuration:

```json
{
  "performance_lights": {
    "amber_slowdown": 0.15,
    "red_slowdown": 0.30,
    "worker_profiles": {
      "worker-a": {
        "hardware": "exact hardware family and memory configuration",
        "model": "exact model identity",
        "quantization": "exact quantization identity",
        "engine_build": "exact engine build and performance configuration",
        "concurrency": 1
      }
    }
  }
}
```

This is an operator attestation, explicitly labelled as such, not live hardware
verification. Use distinct identities for distinct hardware, models, builds,
kernels or performance settings; update the identity when those change. Serial
concurrency is the only supported cohort. Missing fields or another concurrency
leave peer comparison unsupported. Identical full profiles allow matched
cross-process self-history and peer comparisons; a Spark and an M3 must never
be given the same hardware identity.

Only a digest is attached to newly observed prompt-start metric rows. Today's
profile is not applied to old files or journal backfill older than 15 seconds.
Changing profiles preserves old numerical evidence and starts a distinct cohort.
There is no automatic profile assignment or production configuration edit.

## Cache hits

Green requires at least three recent engine starts with observed prefix reuse in
the current process. It reports bounded reuse evidence, not perfect cache health.
Recent low-reuse evidence from the existing continuity audit is amber and asks
for review of history edits, compaction, process changes and exact-prefix evidence.
Missing or stale evidence is grey. The current audit cannot establish fault
causality strongly enough for a red cache verdict; suspicion is never promoted
to a red accusation. Normal cold starts and successful disk restores are not
labelled failures.

The dialog retains measured disk-load components and says that extra time caused
by lost reuse is unknown. Its engine sample list is bounded to the existing
30 non-chunk events, and continuity counts describe retained audit history, not
lifetime totals or a complete 30-minute census.

## Bounds, verification and rollout

The new reader is separate from the fleet-speed accumulator. Each pass reads at
most 4 MiB per selected file, with a maximum eight files and 64 KiB per line. Its
200,000 interval, 400,000 sample-identity and 512 in-flight-worker metadata budgets are explicit; exclusions,
malformed rows, evictions, catching up and rescans remain visible. It never
rewrites, truncates or deletes source history. Reopening the dashboard rebuilds
from numerical files. Raw text, paths, credentials, request identities and
process identities are not returned in the performance summary.

Tests exercise weighted accounting, workload-mix changes, sustained slowdown,
unsupported contexts/peers, configuration separation, restarts, stale/idle data,
counter regressions, overlapping starts, reader reconstruction and prefill
categories. Browser checks exercise the labels, keyboard dismissal, persistence
through polling and unchanged card height. The public examples are synthetic.
A read-only replay of existing metrics found substantial excluded request-boundary
evidence; the source does not reinterpret those gaps as health or failure.

Source and fixture validation do not activate the feature in an already-running
dashboard. No gateway, DS4 server, launcher or model settings were changed.
