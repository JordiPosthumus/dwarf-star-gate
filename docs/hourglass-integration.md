# Hourglass integration status

The owner-started benchmark workflow remains unfinished. Do not start a run,
drain a worker, alter benchmark routes or configure a recurring benchmark merely
because a report is available. Initial runs use the owner's chosen direct-server
setup and time window. The benchmark itself remains Hourglass.

The first data component, `hourglassReportSummary`, reads Hourglass's existing
`hourglass-public-report-v1` aggregate object. It does not read the private bank,
calculate a score, scan directories, make network calls or launch an evaluation.
Dashboard/chat wiring and explicit association with a Star Gate worker and
approved configuration revision remain to be implemented.

## Preserve the recorded methodology

Current Hourglass source inspected on 14 September 2026 reports release 4.0.0,
`total-points-v1`, and `net-hour-v3`. This supersedes the older release/metric
assumptions in the initial integration discussion; it does not rewrite historical
results. A retained aggregate report also demonstrated `linear-auc-100-v1` with
`net-hour-v2`. Its score is an older AUC-derived score, not current total points
or the separately recorded AUC point-minutes.

The projection preserves the reported score and metric version verbatim. Negative
or zero total points remain values. Unknown metric versions retain their number
with an unknown unit. Missing, partial, unavailable or contradictory evidence is
never promoted into a final score, normalized, extrapolated or ranked.

Each summary retains run date separately from report creation time, benchmark
version, scoring and timing policies, frozen bank fingerprint, configuration and
machine keys, active/window seconds, clock adjustment, repeat/round/timeout rules,
recorded hardware label and structured caveat labels/counts. It excludes raw
questions, answers, images, traces, paths, experiment notes and free-form caveat
messages. Selected text fields are bounded, source-reported labels, not verified
infrastructure facts.

Hourglass's configuration key is not a Star Gate approved-record revision; its
machine key is not a gateway worker ID. A report alone does not prove the current
server setup, the request route, absence of contention, or an upgrade. Explicit
associations and their provenance are needed when integrating the summaries.
Do not compare different metrics, banks or execution conditions merely because
model names match.

The projection has offline tests for native and historical metric separation,
missing/partial evidence, optional metadata, preservation of values and omission
of private payloads. These prove data handling, not benchmark validity, current
model performance or completion of the owner-started workflow.
