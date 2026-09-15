# Approved serving changes — development

Genie proposal/status tools and the owner approval/progress UI are connected to
the retained-container workflow in development. Integration tests exercise the
installed Hermes runtime and browser against disposable fixtures. This optional
operation service is not yet active in production; a complete actual serving
operation still needs qualification. Existing production recovery and maintenance
behavior is unchanged.

Genie can inspect linked JSON evidence with `read_server_artifact.reference_chain`.
Each JSON pointer selects a recorded `path`/`sha256` reference in the preceding
document. Start from a named artifact, or omit `artifact` to start at the worker
record (for example, `["/evidence/0"]`). Every traversed file is checked against its
hash and must remain inside the private artifact library. Existing named artifact
calls still work. Read the parent first; references, hashes and report conclusions
are evidence to inspect, not authority to act. Unhashed or non-JSON files remain
explicitly unavailable through this reader.

## Approval and independent execution

`server-operations.mjs` saves a proposed change, its prepared plan and the
approved configuration's revision. Preparing a proposal never launches it.
Approval must refer to the exact saved plan; a changed record or plan requires a
new proposal. The dashboard endpoint requires an explicit owner
action and the same origin/CSRF checks as existing controls. The approval method
is not a Genie tool.

The store records launch intent before calling `operation-runner.mjs`. That
adapter starts a detached Python process, so closing the chat or dashboard does
not stop the operation. `operation_runner.py` independently checks the approval,
plan, configuration record and exact executor source bytes before executing.
The trusted preparation adapter supplies the executor's absolute path and hash;
neither comes from the model's proposal. `serving_bundle.py` embeds the known
serving modules into that one approved source file, including the exact Docker
transport source sent over SSH. `serving_executor.py` joins the enrolled gateway,
Docker, qualification and record components using the saved plan. It does not
reread mutable installation settings while executing. The installed Python
standard library, operation supervisor, gateway and host software remain outside
this serving-code snapshot; it is not a snapshot of the whole installation.

`serving_prepare.py` prepares from installation-owned connection and qualification
enrollment plus the proposed image/complete command. It observes Docker, checks
the approved record and applicable restoration proof, builds the candidate record
and freezes the executor. It never approves, launches or drains. The candidate
record reflects explicit generation/thinking settings and labels unverified engine
defaults as unknown. Historical container/package captures are not relabelled as
fresh observations. Changing the container does not rewrite launcher files or
recovery bindings; the review explicitly states this boundary.

A separate-process fixture executes frozen imports and transport source after
all copied checkout modules change, rejects a changed approved bundle before any
effect, and observes a duplicate without another effect. Preparation-to-entry
tests use synthetic external Docker/gateway/model responses and a real disposable
Git library. These are component-integration checks, not a real fleet operation.

An exclusive durable claim prevents duplicate execution. A kernel-held file lock
establishes process liveness without trusting an old PID. Observation after a
crash does not restart the operation. Approval saved before any launch intent
can finish its original submission; an uncertain launch is only observed.
Records of declined, failed and interrupted operations are preserved.

Progress records separate the last phase change from a process heartbeat. A
heartbeat means the runner is alive; it does not mean the model is progressing.
An executor exception leaves an explicit reconciliation state, never an invented
success or claim that the server was unchanged. The enrolled serving executor
must perform and record the actual maintenance and qualification checks before
returning a successful outcome. The process supervisor does not provide those
checks itself.

Tests use a real separate dashboard process and synthetic Python executor: the
dashboard exits, its approved operation continues, and a replacement observes
the same operation. They also cover an abruptly lost fixture process, changed
approval/record/executor bytes, duplicate submission and heartbeat semantics.
These tests prove process behavior, not a qualified model-server upgrade.

## Retained container and SSH transport

`ds4-gateway/docker_profile.py` provides `RetainedProfile` for changing a Docker
serving image and command while retaining the previous container. It accepts
the complete reviewed command and an exact image already present on the host.
Preparation reads the current container and produces a plan bound to the
configuration-record revision and current container identity. It preserves the
other Docker settings and explicit bind mounts.

The coordinator must obtain approval for that exact plan and own the gateway's
existing maintenance window. A SHA256 identifies the plan; it is not approval.
The executor independently checks that the native metrics endpoint is mapped to
the container and has no running or waiting requests. It rechecks ownership and
identity before stopping anything, writes each intent before issuing its action,
and keeps both versions. Duplicate calls observe the saved operation without
replaying uncertain mutations.

`docker_profile_remote.py` carries this executor's Docker requests over the
already-enrolled SSH connection. A fixed Python bootstrap receives JSON on stdin;
model-supplied arguments never enter a shell command. It installs nothing on the
host. Observation has bounded transport waits, while graceful stop has no new
kill deadline. A failed mutation response is uncertain and is never retried by
the transport. Host aliases and the Docker socket must come from enrollment.

## Owned maintenance and conditional readmission

`operation_maintenance.py` uses the gateway's existing Unix control socket. It
records its original worker state, acquires a named hold and waits for gateway
and direct server work to finish without cancelling requests. An uncertain lock
or release response is resolved through the same request's saved gateway
receipt, never by repeating the mutation. Releasing its own hold is separate
from returning the server to traffic. The serving executor must complete actual
qualification before asking for that return.

The optional `expected_operator_actions` and `expected_maintenance_actions` maps
on `/resume-workers` bind automated readmission to the observed decisions. The
gateway checks them before readiness probes and immediately before committing
the resume. A new pause or maintenance action makes the old request fail. The
latest operator decision is retained separately from the bounded activity history
so pruning that history cannot erase a pause token. Legacy state remains readable;
the new per-worker records are written with subsequent operator actions.

Existing manual Resume works without these optional maps. The operation adapter
requires `conditional_resume_version: 1` from `/workers` before taking a hold;
it cannot silently use an older gateway that would ignore its conditions. It
preserves a preexisting manual pause, leaves other holds intact, and does not
repeat an uncertain readmission request. A recorded readmission result describes
that operation's observation, not a permanent promise about current routing.

The Python adapter has been exercised against a real disposable gateway/backend
fixture with an active request. That request finished without cancellation before
the owned release and conditional return. Native model qualification and the
full approved serving workflow remain separate, unfinished integration work.

## Serving sequence and native qualification

`serving_operation.py` joins maintenance, retained Docker apply, qualification,
record publication and conditional readmission. It verifies the same worker,
endpoint, record revision and retained identity throughout. A candidate that
fails qualification is restored only under the applicable approved record's
restoration rule; the restored version must pass its own checks. An acknowledged
startup followed by an identified stopped container can also take this restore
path. An uncertain mutation is never replayed.

If stopped-candidate preparation fails before any stop intent, the executor can
return the demonstrably unchanged original through fresh maintenance/readmission
checks. A stop intent without a confirmed outcome is not evidence that nothing
happened. Failed or uncertain record publication leaves routing held for
reconciliation. A restart during publication cannot inherit the earlier
qualification. `serving_records.py` publishes to the existing private Git library.
It requires the complete candidate record in the exact owner-approved plan,
binds that record to the reviewed recipe and qualified model/context, and saves
the old record bytes, new record, actual Docker metadata, owner approval and
hashed native request/response evidence. A new image cannot inherit uninspected
package versions. A new candidate does not inherit a restoration-drill claim for
the previous container; the proven old record remains retained with its evidence.
Restoration keeps the original approval and adds the actual new startup evidence.

The writer supports a library inside a larger personal repository. It commits
only its record and operation artifacts, runs ordinary Git hooks, preserves
unrelated staged work and never pushes the private repository. Existing edits
to the target record fail preflight before draining. A failed or uncertain commit
preserves files and the hold for reconciliation; the operation does not repeat it.
The publisher also retains the frozen executable and exposes the new Docker
capture through Genie's existing recreation-artifact reader. Installation
enrollment and Genie/dashboard integration are not yet active in production.

The record's `restoration.change_classes` maps `serving_flags` and/or
`engine_image` to retained restoration data: automatic mode, retained container
and canonical Docker signature, external-state preservation, restore steps,
required success-check IDs and a hashed drill reference under `artifacts/`.
The dated proof must identify the same worker and restored configuration, with
`state: restored-in-drill` and successful checks. A descriptive label or a proof
for another configuration is insufficient. Existing private records and older
receipt formats are not silently rewritten or treated as this enrollment.
Missing or additional unsupported success checks prevent the operation starting.
This grants no authority to the existing automatic recovery executor.

`serving_qualification.py` reuses the checks exercised on the selected Spark
build: native model/context, text, real tool calls and follow-up, vision, two
interleaved cold/warm cache conversations, full-context and overflow boundaries,
reasoning/content EOS behavior, and native abort/error/preemption counters.
Requests and raw responses are saved with hashes. Large full-context bodies are
separate artifacts, so operation-status receipt limits cannot truncate them.
The 16-token EOS requests are diagnostic only. Inference is never retried and
has no newly imposed cancellation deadline. Readiness observations have bounded
transport waits; an answering API with the wrong model fails qualification
instead of waiting indefinitely for its identity to change.

This first qualifier covers the enrolled Qwen/vLLM contract and existing native
endpoint/model identity. A two-request native contract is now available by adding
`"concurrency": 2` to the candidate qualification when its exact recipe uses
`--max-num-seqs 2`. The previous contract stays serial when restoring a
one-request baseline; a two-request previous recipe needs its matching contract.
A serial contract cannot qualify a changed two-request recipe.

The two-request check first requires idle native gauges, then observes two
constrained completions actually running together. Two successful serialized
replies do not pass. It next submits two distinct client flows through the full
API, tool/follow-up, vision, cold/warm cache, context and EOS checks. Different
expected tool arguments catch crossed or incorrect results. Each flow retains
its own raw artifacts; full-context requests may serialize under memory pressure.
This is not proof that every individual check overlapped, a speed ranking or an
exhaustive model-quality/output-length assessment.

The 30-second gauge-sampling window bounds observation and saved samples only.
It never cancels inference: both replies still finish, including after an observed
error, and the coordinator checks native idle before restoration or readmission.
Preparation shows which checks apply to each version. Native qualification does
not change gateway capacity; enabling gateway slots is a separate explicit step.
Arbitrary model families, higher native capacities and fresh-machine setup remain
outside this contract. Changing routing requires its reviewed workflow. The current direct HTTP adapter
uses the unauthenticated loopback API of the selected serving setup. Other
authentication arrangements need their enrolled transport before activation.

Sequence tests use the real component code with synthetic external Docker,
gateway and API fixtures; publication integration uses a real disposable Git
repository, including unrelated staged work and a failing hook. Separate real
loopback HTTP tests cover
request bytes, error evidence and redirects. Read-only models/metrics checks on
enrolled hosts verify the native-read transport. None of these is a complete
production upgrade or a fresh native-model qualification of this new workflow.

Apply returns `started_unverified`; restoration returns `restored_unverified`.
Neither state authorizes routing. The complete workflow must check the actual
model, settings, generation and cache behavior, save the evidence, and release
only its own maintenance hold before readmission. Automatic restoration also
requires the record's applicable retained-version and restoration authority;
this component grants none on its own.

This first adapter does not handle anonymous volumes, self-removing containers,
or an `always` restart policy whose retained-container behavior has not been
established. It does not rewrite those settings. Image download, weights, shared
dependencies, service definitions and fresh-host provisioning require their
appropriate preparation and approval paths.

Validation includes interruption and uncertain-response cases, identity changes,
busy workers, lost maintenance ownership, receipt-write failures, wrong native
bindings, and preservation of unrelated settings. An optional real-Docker test
uses an already-cached Node image and disposable CPU fixtures. It verifies busy
refusal, cutover, retained original, restoration and duplicate observation, then
cleans up only its own container IDs. That test does not qualify a model server
or the unfinished gateway approval workflow.

Run the unit checks with `python3 ds4-gateway/docker_profile_test.py`. The native
test's module docstring describes its explicit Docker socket, cached image ID and
new evidence-directory inputs; it never pulls an image or discovers fleet targets.
Run the approval, real-process and transport checks with `npm run operations:test`.

## Optional Genie and dashboard connection

`server_operations.enabled: true` connects the operation service only when the
installation explicitly enrolls its `workers`. Each worker reuses its existing
`genie_chat.inspection.workers` container and first SSH alias, with the enrolled
`native_url`, optional `docker_socket`, and explicit `qualification.candidate`
and `qualification.previous` contracts. The native contracts are those consumed
by `serving_qualification.py`; they require installation evidence, not guessed
defaults. Worker management, the private record library and configured Genie
interpreter must already exist. Preparation checks the gateway's conditional
readmission support and committed approved-record bytes before offering approval.
No existing installation is enrolled automatically.

Genie receives `propose_server_change` and `server_change_status`. Their private
loopback endpoint has a separate process-scoped token and no approval action.
Tool calls are retained with the reply; status omits full commands and executable
paths. The owner-facing Server changes card shows exact recipes, checks, known
capacity/thinking differences and the plan revision. Its approval requires the
existing same-origin dashboard session. A proposal or chat message cannot grant
that approval. The card reports independent runner progress and retains results
across page reloads. Heartbeat age is distinct from useful model progress; a
saved success is not presented as a new health inspection.

Testing mode prevents new preparation and approval but does not cancel an
existing operation. Closing the dashboard does not terminate an approved runner.
Ambiguous submissions are observed using their original operation ID and never
automatically repeated. Neither the chat nor inference deadline is shortened.
Read-only proposal preparation and local tool HTTP exchanges have transport
limits; those do not impose a cancellation deadline on a serving operation.

This connection passes disposable API/process/browser tests and a real installed
Hermes test using synthetic model responses. Private restoration enrollment and
a complete native-server operation still require their actual evidence before
production activation. Fresh-host provisioning and arbitrary model contracts
remain separate unfinished work.

Existing restoration evidence may be normalized into the recorded proof format
without repeating a drill. Retain original dates and actor, exact container
configuration, original requests/responses and their hashes, the checks actually
passed and the demonstrated scope. Re-evaluate the saved checks and compare the
retained live configuration before enrollment. A flag-change restoration must
not silently become proof of an image upgrade or installation on another host.
Changing a record does not change generic recovery bindings; correcting those
bindings can remove an existing recovery veto and needs its own behavior check.

Genie receives dated recovery policy and per-worker eligibility separately. A
binding mismatch does not imply that the global automatic-recovery switch is
off. The existing read-only artifact tool can open `serving_flags_restoration`
using that class’s exact hashed drill reference, independently of the original
`restoration_drill` receipt. This adds evidence access, not mutation authority.
