# Hourglass integration status

This release includes optional owner-started controls, durable receipts and report
collection. Real-run qualification and production connection remain unfinished. Do not start a run,
drain a worker, alter benchmark routes or configure a recurring benchmark merely
because a report is available. Initial runs use the owner's chosen direct-server
setup and time window. The benchmark itself remains Hourglass.

The first data component, `hourglassReportSummary`, reads Hourglass's existing
`hourglass-public-report-v1` aggregate object. It does not read the private bank,
calculate a score, scan directories, make network calls or launch an evaluation.
The dashboard displays explicitly selected reports under Evidence →
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
a scripted model provider; they prove wiring, not model performance. Real-run qualification, measured contention and approving a server configuration
remain separate unfinished parts of the plan.

## Native console adapter

`hourglass-console.mjs` prepares a start against an explicitly connected local
Hourglass console. It reads the saved model catalogue and full-bank revision
metadata, then submits the native `models_revision`, `hardware_revision` and
`task_bundles` preconditions. It sends no model-setting overrides, starts no
shell/server process and leaves Hourglass's clock, warm-up and round rules intact.
The console origin must be an explicit `http://127.0.0.1:PORT` URL. Responses are
bounded to 64 MiB and requests use a 15-second observation timeout, with redirects
and automatic retries disabled. A start timeout does not cancel Hourglass work.

Preparation does not start a run. Submission requires the exact prepared ID and
an explicit owner-confirmed free measurement window. The review can submit once;
connection loss or an invalid acknowledgement is an uncertain outcome, never
permission to replay. Native validation rejection is reported without exposing
its error body. The visible settings are a limited summary; the full native
Hourglass entry, including its existing overrides, remains authoritative.

With a configured console, the Evidence tab provides Review measurement, a free-window
confirmation and Start one-hour measurement. Start intent is flushed to private
`runtime/hourglass/runs.json` before submission; the native job receipt is saved
before success is shown. Duplicate submissions return the existing receipt.
Dashboard restart resumes observation of known jobs without submitting them again.
An interrupted submission remains uncertain. The owner can check the native
console and record that no related work remains active; this is an explicit owner
statement, never reconstructed acceptance or automatic cancellation.

While an owned run needs observation or a terminal report is missing, the existing
dashboard reads its status every 15 seconds. This timer cannot start a run. Native
aggregate previews are projected through the existing report allowlist, saved
with the run and shown in Evidence and Genie context. Result collection neither
publishes to GitHub nor reads question/answer details into Genie. Measurement
receipts give chat the worker, state, dates and attention flag; endpoint settings,
raw errors and native task data are excluded from that chat projection.

Private history is retained, with the latest 20 runs displayed and up to 50 saved
run summaries supplied alongside explicitly selected reports. The single-dashboard
history file is bounded at 4 MiB; reaching the bound stops new writes/starts rather
than discarding earlier measurements. Preserve it when moving the installation.
A missing native job or unavailable console preserves the receipt and its last
observation, with an attention message. Nothing is automatically resumed or stopped.

Configure explicitly in private Star Gate settings:

```json
"hourglass_console": {
  "url": "http://127.0.0.1:4534",
  "targets": [
    {"model": "A saved Hourglass model name", "worker_id": "example-worker", "route": "direct"}
  ]
}
```

The target name must match a saved Hourglass entry. The worker and route are
operator-supplied associations, not inferred topology or traffic isolation. The
review links the current approved Star Gate record if one exists and says when
none exists. Existing native overrides remain in effect; Star Gate does not edit
Hourglass model declarations or gateway routes. No configuration means the controls
are absent and no Hourglass service is contacted. Hourglass must already be running;
Star Gate does not install or start its separate application.

Native compatibility was also checked using an isolated copy of the inspected
committed Hourglass 3.0.0 source, independently of its uncommitted 4.0.0 changes.
Through the real native HTTP handlers, preparation preserved the 3.0.0 AUC metric,
submission froze the saved model unchanged, observation found the pending receipt,
and native preview/report retrieval preserved the legacy score and protocol.
Separate native enqueue checks rejected changed model, bank and hardware revisions.
The fixture used a synthetic bank and injected completion timestamps; no benchmark
worker or model request ran. This proves the tested API contract, not an actual
one-hour measurement or compatibility with every Hourglass release. The normal
console must be running and its configured target reviewed before a real run.

The same native HTTP workflow also passed against a source snapshot reporting
Hourglass 4.1.0 on 15 September 2026, preserving `total-points-v1`. Native enqueue
rejected changed model, question-bank and hardware revisions without creating a
second evaluation. This used a disposable source copy, synthetic question and
synthetic completion; no model worker ran. It proves compatibility with those
tested source bytes, not a released version or a completed real benchmark.

Run that opt-in check against a trusted Hourglass checkout with:

```sh
python3 scripts/hourglass-native-integration.py --source /path/to/Hourglass
```

Use `--node /path/to/node` if Node 22+ is not on PATH. The fixture copies only
top-level Python source into a temporary directory, creates its own model and
question, and starts only an HTTP handler on an ephemeral loopback port. It does
not import the live checkout, launch its worker or copy its configuration,
history or bank. Output identifies the copied source hashes and explicitly labels
the synthetic completion. A source change during verification fails the check.

Check the **running** console's `/api/health`, not just the files on disk. A legacy
JordiBench process can continue serving older code after its checkout is updated.
A missing health API now produces a version/port diagnostic; Star Gate does not
automatically restart or upgrade that process. Starting a newer native console
may reconcile saved evaluation history, so a second console against the same
working directory is not an appropriate compatibility test.
