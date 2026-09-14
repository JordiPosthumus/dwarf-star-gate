# Hourglass integration status

The owner-started benchmark workflow remains unfinished. Do not start a run,
drain a worker, alter benchmark routes or configure a recurring benchmark merely
because a report is available. Initial runs use the owner's chosen direct-server
setup and time window. The benchmark itself remains Hourglass.

The first data component, `hourglassReportSummary`, reads Hourglass's existing
`hourglass-public-report-v1` aggregate object. It does not read the private bank,
calculate a score, scan directories, make network calls or launch an evaluation.
The development dashboard displays explicitly selected reports under Evidence →
Hourglass results, and conversational Genie receives the same bounded summaries.
Each answer saves the report revision and supplied associations with its evidence.

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

## Select saved reports

Add explicit aggregate report references to your private Star Gate configuration:

```json
"hourglass_reports": [
  {
    "file": "./benchmarks/report.json",
    "worker_id": "example-worker",
    "route": "direct",
    "contention": "owner-confirmed-idle"
  }
]
```

Paths resolve beside the configuration file. Only `file` is required. Optional
`approved_configuration_revision` accepts a full 64-character lowercase SHA-256
revision from an existing approved Star Gate record. Supplying it associates the
report; it does not create, approve or verify a configuration. Worker, revision,
route and contention are explicitly labelled operator supplied. Missing values
remain unknown. Routes accept `direct`, `gateway`, `testing-door` or `unknown`;
contention accepts `owner-confirmed-idle`, `observed-contention` or `unknown`.

No configuration means no report panel or report reads. Up to 50 explicit regular
files of at most 1 MiB each are supported. Symlinks and named pipes are rejected.
Unchanged summaries are cached; changed files get a new content revision. A missing,
invalid or unreadable file is unavailable, never a cached earlier result or an
invented zero. Files and their parent directories should be operator controlled.
The dashboard serves the summaries, not the source files or their paths.

Selected summaries are included in the configured chat model's context and saved
with its answer in private chat history. Raw benchmark questions, answers, notes
and traces are excluded. Run, machine, configuration, bank and report identifiers
are blocked from public web-tool inputs. This does not make report labels verified
facts or change the installation's existing model-provider privacy boundary.

Validation covers file replacement/failure handling, bounded reads, optional
associations, normal dashboard startup, preserved answer evidence and research
identifier filtering. Browser and native Hermes checks use synthetic reports and
a scripted model provider; they prove wiring, not model performance. Running a
benchmark, measuring contention and approving a server configuration remain
separate unfinished parts of the plan.
