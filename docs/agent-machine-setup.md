# Agent runbook: prepare and add a machine

Use this guide to add a DGX Spark or another compatible DS4 server to an existing
DSG fleet. A local agent with authorized shell/SSH access can perform the work;
no particular agent framework is required. This is an operator setup task:
scoped credentials from [the agent API](agent-api.md) do not grant worker
registration, remote installation or arbitrary configuration access.

Adding a worker is supported live. Registration creates its tunnel, probes
compatibility and leaves it **paused**. A separate checked resume admits work.
Existing DSG services and model servers do not need restarting for registration.
DSG does not install DS4, download weights, provision SSH or transfer KV caches.

## Copyable agent handoff

Replace the bracketed details; keep the completed handoff private.

> Prepare [new machines / verified SSH aliases] and add them to the existing DSG
> checkout [absolute path], using private config [absolute path]. Read
> `docs/agent-machine-setup.md` and follow its acceptance and rollback steps.
> Use [owner-selected engine/model/profile, or named existing reference server]
> and register them as [unique worker IDs]. Set up engine logs and hardware
> telemetry as part of onboarding. Inspect the live fleet and reference settings
> first; preserve every unrelated setting, service and cache. Back up affected
> files before changes and record the intended delta. Provision only the named
> new machines, register them paused, validate directly, then enable and verify
> routing through the existing Door. Record real cache-reuse evidence and the
> effective context/output/concurrency settings. Do not clear existing caches or
> carry diagnostic limits into production. Resolve routine setup choices from
> the existing installation; ask only for missing required information or an
> unapproved capability reduction. Report results, remaining gaps and rollback
> paths without exposing credentials or private machine details in Git.

For a new gateway installation, complete the [Quick start](../README.md#quick-start)
first. For fleet expansion, use the running checkout/configuration; do not run
setup again, create another gateway, regenerate its key or replace its state.

## 1. Inspect and record the intended setup

Run these read-only commands from the selected DSG checkout. Use an absolute
`DWARF_GATE_CONFIG` if the installation does not use its root `config.local.json`:

```sh
./workers.sh list
npm run doctor
```

Read the live roster, health, pool model/context, admission state and existing
reservations. Doctor checks local configuration; it does not prove worker health
or perform inference. The durable registry in the configured affinity state is
authoritative after registration changes. Editing `config.nodes` is not an
onboarding method for an established registry.

Record privately, for each new machine:

- Its physical identity, unique worker ID and verified SSH alias; register each
  physical server once. Check for prior/partial registration before retrying.
- The chosen engine revision/build, exact model and vision artifacts, checksums,
  service unit and launch environment. Inspect the live reference installation
  rather than assuming an older document still matches it.
- Native context, default output allowance, thinking, concurrency, hot/disk cache
  configuration, quantization, kernels and speculative-decoding settings.
- Remote loopback inference port, unused local tunnel port, storage capacity,
  cache path and telemetry sources. Resolve missing required details with the
  owner; do not invent endpoint identities or silently pick a smaller profile.

Keep timestamped, permission-restricted backups of affected configuration,
launchers/service definitions and the existing DSG config/affinity file. Record
source revisions, file hashes and exact intended edits. Keep backups and private
receipts outside published source (for example in ignored `runtime/`). A snapshot
of affinity state is evidence, not permission to restore it over newer sessions.

## 2. Prepare and validate DS4 on the new machine

If DS4 already runs correctly there, inspect and validate it without reinstalling.
Otherwise stage the owner-selected engine, prerequisites, weights and persistent
service on that machine using the engine's instructions. The
[Spark profile](recommended-spark-profile.md) contains pinned build/artifact and
launcher guidance plus known limitations; it is not permission to overwrite a
working or newer owner-selected profile. Consult the selected revision's upstream
instructions before using its flags or build commands.

Establish SSH authentication and verify the host key using a trusted source.
Keep the DS4 listener on loopback and access it through SSH. Preserve working
binaries, launchers and caches for rollback. Do not clone another machine's
credentials, identity, runtime affinity state or active KV directory.

Inspect the **effective running** settings, not just a file or successful start.
Run direct tests on the new endpoint while it is outside fleet admission:

- Model/context reporting and streamed completion, including reasoning, tools
  and vision when part of the selected profile.
- Representative long-context and output behavior, and the configured concurrency
  boundary. Record actual tested sizes and outcomes; a short request cannot
  certify the advertised limits. Keep test request limits separate from the
  normal service configuration.
- A real cold-to-warm prefix reuse test with a fresh synthetic conversation,
  followed by the same prefix on the same worker. Record cold/warm usage counters
  or attributable engine evidence and timings. Do not clear existing caches to
  manufacture a cold run. If persistent cache is part of the setup, separately
  validate disk restore using the selected engine's documented method.

Use the [cache audit](cache-continuity-audit.md) to interpret evidence. A faster
second response alone does not prove a cache hit. Report missing evidence as a
validation gap; do not claim full acceptance from health checks alone.

## 3. Register paused, then connect observation

The following values are examples, not discovered endpoint details. Substitute
verified values and run from the DSG checkout:

```sh
./workers.sh add worker-c \
  --url http://127.0.0.1:38103 \
  --ssh worker-c \
  --remote-port 8000 \
  --journal-unit ds4-vision-q2.service
./workers.sh list
```

Here `38103` is an unused port on the **gateway host**; `8000` is the DS4 loopback
port on the **remote host**. DSG owns the tunnel. Supply the actual Linux user
journal unit, or omit `--journal-unit` if no supported unit exists. Omission leaves
engine-log telemetry disabled for that worker. A same-host endpoint uses its real
loopback URL without `--ssh` or `--remote-port`.

Registration checks model/context compatibility. Keep the worker paused while
resolving failures. Every enabled worker must support the existing pool context;
do not lower the pool guarantee or change client settings to admit a smaller
server. See [context limits](context-limits.md). If an add returns an uncertain
result, inspect the roster before retrying; never register the same endpoint
under a second ID to bypass a failure.

For a Spark, merge a new entry into the existing private
`hardware_telemetry.workers` map:

```json
"worker-c": { "adapter": "nvidia-linux" }
```

This is a map entry, not a replacement configuration. Preserve existing entries
and enabled/interval settings. If hardware telemetry is not already configured,
follow [hardware telemetry](hardware-telemetry.md) to enable it. Run doctor after
edits. Apply telemetry changes to the dashboard only, waiting for any Genie
review to finish before replacing its process; on the documented macOS services,
use `npm run service -- restart dashboard`. On Linux use the existing supervisor.
Do not restart the core or DS4 to apply observation changes.

Verify the new card, fresh engine observations and available hardware readings.
Respect power/temperature scope and freshness; unsupported fields remain unknown.
See [monitoring](../README.md#monitoring-and-debugging) for other log sources.
Recovery enrollment is separate: adding a worker does not authorize automatic
service restarts. Enroll it only if requested, using the
[recovery guide](agent-recovery-enrollment.md).

## 4. Enable and verify fleet behavior

After direct validation and compatibility checks pass:

```sh
./workers.sh resume worker-c
./workers.sh list
```

Do not clear someone else's hold, lock, pause or quarantine to make resume pass.
Verify the new worker is eligible, then use the existing authenticated Door
endpoint for a fresh synthetic conversation. Keep the key out of logs and shell
traces. Confirm actual placement and completion in Current Jobs/request history;
then verify a follow-up retains affinity and inspect its cache evidence. An
ordinary request may select another idle worker, so success through the Door
alone is not proof that the new worker served it. Observe placement without
pausing other people's workers to force the result.

Verify existing worker identities/settings and client endpoint remain unchanged.
New capacity serves eligible new work; existing conversations keep affinity and
safe queued handover follows the [normal rules](simplified-system.md#load-balancing).
Adding machines does not automatically rebalance all conversations or move caches.

## 5. Hand back or roll back

Report each worker's registered/paused/eligible state, effective settings, direct
and Door test outcomes, exact cache evidence, telemetry freshness and any
unexercised boundaries. Include private backup/receipt paths and whether setup
is complete or which acceptance item remains. Update only generic documentation
in Git; keep hostnames, routes, keys, prompts and operational logs private.

If validation fails after admission, drain **only the new worker**:

```sh
./workers.sh drain worker-c
```

Wait for its queued and active work to finish. Check for work outside DSG before
stopping its model service. Leave it paused for diagnosis, or remove its
registration when rolling back this addition is appropriate:

```sh
./workers.sh remove worker-c
```

Revert only this task's telemetry/configuration edits against the latest files;
do not overwrite concurrent changes or restore an old whole-fleet affinity file.
Preserve the new machine's model/cache data and release only reservations owned
by this task. Report any incomplete cleanup explicitly.
