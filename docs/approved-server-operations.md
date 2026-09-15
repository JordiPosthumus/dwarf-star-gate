# Approved serving changes — development

The conversational Genie does not yet execute this workflow. The retained
container executor, approval store, independent runner, SSH transport and owned
gateway maintenance adapter are
implemented and tested as components. Connecting the chat and approval UI to
the complete maintenance, model qualification and readmission workflow remains
unfinished. Existing recovery and maintenance behavior is unchanged.

## Approval and independent execution

`server-operations.mjs` saves a proposed change, its prepared plan and the
approved configuration's revision. Preparing a proposal never launches it.
Approval must refer to the exact saved plan; a changed record or plan requires a
new proposal. The future dashboard endpoint must require an explicit owner
action and the same origin/CSRF checks as existing controls. The approval method
is not a Genie tool.

The store records launch intent before calling `operation-runner.mjs`. That
adapter starts a detached Python process, so closing the chat or dashboard does
not stop the operation. `operation_runner.py` independently checks the approval,
plan, configuration record and exact executor source bytes before executing.
The trusted preparation adapter supplies the executor's absolute path and hash;
neither comes from the model's proposal. This hash binds that entry-point file,
not arbitrary dependencies it imports. A complete serving adapter must also
verify its required implementation and qualification artifacts.

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
