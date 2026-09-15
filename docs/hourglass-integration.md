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

Use `--node /path/to/node` if Node 22+ is not on PATH. The fixture copies
top-level Python source and the available Pi adapter/lock files into a temporary
directory, creates its own model and
question, and starts only an HTTP handler on an ephemeral loopback port. It does
not import the live checkout, launch its worker or copy its configuration,
history or bank. Output identifies the copied source hashes and explicitly labels
the synthetic completion. A source change during verification fails the check.

To qualify a specific saved native entry, pass `--model-file /path/to/model.json`
with one model object. The fixture freezes that complete entry unchanged in a
synthetic evaluation and checks stale model, bank and hardware rejection. It still
starts no model worker, even if the entry points at a real server. Raw model
configuration and credentials are not emitted; the result includes the native
aggregate summary, so keep it private when its model/hardware labels are private.
This also exercises native Pi metadata capture when the supplied entry uses it.

Check the **running** console's `/api/health`, not just the files on disk. A legacy
JordiBench process can continue serving older code after its checkout is updated.
A missing health API now produces a version/port diagnostic; Star Gate does not
automatically restart or upgrade that process. Starting a newer native console
may reconcile saved evaluation history, so a second console against the same
working directory is not an appropriate compatibility test.

## Prepare a measurement with Genie

When an Hourglass console and targets are configured, conversational Genie gets
`prepare_hourglass_measurement` and `hourglass_measurement_status`. Ask him to
prepare a measurement for a configured target. His proposal appears in the
existing **Evidence → Measure with Hourglass** review, with the native settings
and revisions available for inspection. The owner still chooses the free window
and presses Start. Preparation does not reserve or drain the server.

Genie can refresh dated observations of an accepted run and see whether its
aggregate report has been saved. Missing observations remain uncertain; his tool
does not retry a start, cancel a run or declare it stopped. The tool results are
retained in private chat history under **Hourglass tool calls**. Fleet reviews do
not receive these conversational tools.
An empty Star Gate history does not prove that no benchmark ran directly in
Hourglass or that no score exists elsewhere; the tool states this coverage limit.

The tool endpoint has a private per-dashboard credential and accepts only prepare
and status. Owner start/resolve controls keep their separate same-origin session.
Asking for the same pending target returns the existing review; Genie cannot
replace a different pending review. These tools use the existing receipt store
and observation timer, without another scheduler. The current pending review is
in memory and must be prepared again after dashboard restart; accepted or
uncertain start receipts remain durable.

This is preparation and observation support. Automatic measurement scheduling,
gateway-owned contention protection and real benchmark qualification remain
unfinished. Public research permission does not itself start a measurement.

## Owned measurement sequence in development

`hourglass_operation.py` implements the sequence for an independently approved
measurement, reusing `operation_maintenance.py`. Its lifecycle is: record the
exact plan, verify the target, acquire an owned gateway hold, wait for existing
gateway and direct work, submit the native request once, observe its saved job,
wait for direct work to finish, verify the target again, then release only its
own hold and request conditional readmission. It never changes serving settings.
The optional maintenance purpose changes the visible hold description; existing
serving-operation behaviour and its default control channel are unchanged.

The native adapter must bind `check_target` to the reviewed endpoint and serving
identity, `idle` to actual direct-server work, `submit` to the reviewed Hourglass
request with revision checks, and `observe` to that exact native job. These are
trusted installation dependencies, not model-supplied callbacks. Native job
termination does not establish a score; existing aggregate collection is separate.

An explicitly proven pre-acceptance rejection returns the unchanged, verified
idle worker without another start. The native adapter must never classify a
timeout or missing acknowledgement as that definite rejection.
An uncertain start keeps the hold and cannot be replayed. An observation failure
or unknown native state keeps following the same receipt without cancelling work.
An acknowledged job can be observed again from its saved receipt after an observer
exit. An interrupted readmission requires reconciliation instead of another resume
request. A newer manual decision or changed serving identity prevents automatic
readmission. No one-hour wall-clock kill timer is introduced.

Tests cover these paths using the real maintenance receipt code and simulated
native/gateway responses. The frozen entry now executes through the existing
independent approval runner; trusted plan preparation and wiring into the
dashboard's Start control remain unfinished. The existing owner-confirmed
idle-window workflow is unchanged; production contention protection and a real
benchmark remain unproven. This development module grants Genie no new authority.

`hourglass_native.py` binds the native protocol to read-only Docker/vLLM checks.
The container configuration signature, startup identity, port binding and served
model must match the reviewed target. Direct idle checks reuse the existing
native metrics reader. The initial adapter supports this enrolled Docker/vLLM
path; other runtimes need their corresponding native idle and identity checks.

Before POSTing, it checks the reviewed controller, model endpoint and identity,
model/hardware revisions, full question-bank hashes, one-hour window, benchmark
version and scoring policy. A busy native console or changed review is rejected
before submission. Native 400 is a definite validation rejection; redirects,
timeouts, other errors and malformed acknowledgements never cause a retry. The
15-second HTTP observation limit does not cancel native benchmark work. After
acceptance, a replacement controller can supply the same job/model receipt without
starting another run. Missing or conflicting receipts remain unknown.

`hourglass_executor.py` combines this adapter with the owned sequence.
`build_executor(..., kind='hourglass')` freezes its seven local source modules
using the existing approved-source mechanism. Normal serving bundles keep their
existing default. The independent runner still requires matching owner approval,
launch intent, unchanged configuration-record bytes and the exact executor hash.
The runtime, SSH enrollment and gateway remain outside that source snapshot.

Integration tests exercise the actual entry, native HTTP requests, receipt
sequence and independent process with synthetic Docker/gateway/controller state.
Changing the copied checkout after approval does not change the frozen execution,
and invoking the runner again does not submit another native job. This proves
the tested wiring, not a real benchmark, live contention protection or production
enrollment. A lifecycle marked completed retains the separate native outcome,
including rejection or error; it does not establish a measured score.

`hourglass_prepare.py` prepares this owned workflow from the installation's
`HourglassConsole.prepared` snapshot. The proposal identifies only the operation
and worker; connection details and the native payload come from trusted setup
and the native review. It checks the current gateway worker URL, compatible
conditional readmission, committed approved-record bytes, actual Docker
configuration/startup/port/model, and the unchanged native benchmark review.
It freezes the measurement executor only after those read-only checks pass.
Busy serving requests do not prevent preparation. No approval, maintenance hold,
native run, record publication or serving mutation occurs during preparation.

The review includes the observed image and complete command alongside the
versioned configuration reference. Their association is not proof that every
observed setting matches the approved record. The gateway URL and enrolled native
target establish the intended endpoint mapping; preparation does not independently
trace an SSH tunnel. The executor rechecks the gateway URL with native identity
before measuring and before readmission. A changed mapping is not silently used.
No restoration drill is required for this measurement-only preparation, because
it does not replace a server or its configuration.

Existing direct owner-confirmed-idle runs retain their current behavior.
Temporary-fixture tests cover stale reviews/routes/records, busy-worker
preparation, executor freezing and the existing runner's exact approval checks.
A read-only preparation against a live Spark checked real gateway and container
metadata with a synthetic benchmark catalogue; it did not run Hourglass or prove
live measurement behavior.

### Optional owned measurement windows

The dashboard connects this preparer to Start when an explicit direct target
includes a `maintenance` object:

```json
{
  "model": "Saved Hourglass model name",
  "worker_id": "example-worker",
  "route": "direct",
  "maintenance": { "native_url": "http://127.0.0.1:8001" }
}
```

This target belongs in the existing `hourglass_console.targets` array. The
installation also needs worker management, a control socket with conditional
readmission, versioned server records, the configured Genie interpreter, and an
existing inspection enrollment for the same Docker/vLLM worker. The SSH host and
container come from that enrollment; the Docker socket defaults to
`/var/run/docker.sock` and can be specified in `maintenance.docker_socket`.
The selected Hourglass entry must address the current gateway worker directly.
Omitting `maintenance` retains the original free-window workflow.

Genie can request a review and inspect progress. Only the owner's same-origin
Start action approves the exact saved plan. The existing operation store saves
approval and launch intent, and the independent runner verifies their hashes.
The dashboard never starts this native benchmark directly. Its existing polling
shows the runner's waiting/measurement phases, process status and dated heartbeat;
heartbeat and model progress remain distinct. Closing/reopening the dashboard
observes the same runner and native receipt without replaying a launch.

A record change detected before launch produces a rejected start and permits a
fresh review. An uncertain launched operation remains visible and blocks another
measurement until its outcome is established. The direct-run “I checked Hourglass”
control cannot clear an owned operation: its maintenance outcome also matters.
The UI does not yet offer a dedicated reconciliation action for an interrupted
owned runner. Inspect its saved operation and maintenance receipts; do not delete
them or start a replacement to clear the display.

Validation includes owner/tool HTTP separation, exact approval, durable start
intent, duplicate-start suppression, failed receipt persistence, record changes,
and a real independent Python fixture process surviving dashboard closure.
That fixture simulates the measurement outcome; it is not an actual Hourglass run.
Browser inspection checked the review, Start, waiting text and heartbeat with
disconnected synthetic services. Production enrollment and the first real owned
measurement remain unverified.

### Complete isolated integration check

```sh
python3 scripts/hourglass-owned-integration.py --source /path/to/Hourglass \
  --node /path/to/node --evidence /path/to/new-evidence-directory
```

This optional check copies trusted native Python source into a retained temporary
directory. It runs the actual Star Gate gateway, dashboard, private preparation
CLI, frozen measurement executor and independent runner, plus the copied
Hourglass HTTP handlers. A fixture SSH command executes the real transport
bootstrap against simulated Docker and model endpoints. It does not connect to
an existing installation or start Hourglass's benchmark worker.

The test verifies that an active gateway request finishes after its worker is
held for measurement, that another worker still serves, that preparation and
owner Start produce exactly one native job, and that a restarted dashboard
observes the same independent runner. The copied console then receives an
explicitly synthetic completion; the runner releases its own hold, conditionally
readmits the worker, and the dashboard collects the native aggregate report.
Neither the synthetic hour nor its zero score measures actual model performance.

The evidence directory records the source hashes, native submissions, Docker reads and
gateway log. `fixture-path.txt` identifies retained synthetic configuration,
approval and runner receipts. Fixture listeners and processes close on completion;
files remain for inspection. The original Hourglass checkout is read only and
its copied source hashes are rechecked after the test. A passing check qualifies
this integrated control path with the tested native source, not live benchmark
performance, new-machine provisioning, or all failure/reconciliation cases.
