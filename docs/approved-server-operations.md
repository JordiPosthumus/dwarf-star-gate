# Approved serving changes — development

The conversational Genie does not yet execute this workflow. The first executor
component is implemented and tested; connecting explicit approval, durable
operation supervision, model qualification and readmission remains unfinished.
Existing recovery and maintenance behavior is unchanged.

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
