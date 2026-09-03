# Agent access to DSG

Agents can inspect the fleet and temporarily drain **named workers** through a
small versioned API. They use DSG's existing private Unix control socket and
serialized executor—not SSH commands, a new daemon, or a second scheduler.
The supplied `agents.sh` client works with any agent capable of running a command.
No Pi, Hermes, MCP server, or agent framework is required.

The code is available in this release. An existing deployment must load the new
gateway and dashboard code before using it; a Git update alone does not activate
it. Check `agent_api_version: 1` in gateway status. Plan a normal controlled
cutover; do not restart live inference merely to try this guide.

## What “permission” means

There are two separate steps:

1. **Tell the agent what you authorize.** Name the worker and task, require it to
   release its reservation when finished, and say what it must not touch. The
   agent's shell/tool environment must also permit running the client.
2. **Grant API scope.** An operator creates a private credential limited to those
   worker IDs. The agent gets its credential path, not DSG's full configuration.

This is an accident-prevention and attribution boundary, **not a sandbox against
an agent with the operator's full OS account**. That account can already access
the raw operator socket, files and other credentials. A bearer credential proves
possession of that grant, not the identity of a particular model or human. Use
separate OS identities/restricted tool access if hostile same-user processes are
in scope. Do not expose this socket or a raw control proxy on the LAN.

## Operator setup

From the repository root, after activating this release:

```sh
mkdir -p runtime/agent-credentials
chmod 700 runtime/agent-credentials
./agents.sh grant ds4-tester --workers worker-a --out "$PWD/runtime/agent-credentials/ds4-tester.json"
```

Use your registered worker ID from `./workers.sh list`. Multiple IDs are
comma-separated. `--config FILE` or `DWARF_GATE_CONFIG` chooses an operator's
private configuration. The credential is created exclusively, mode `0600`, and
contains the local socket path and a random token. The token is not printed;
only its SHA-256 hash is persisted in gateway state. Never commit or paste the
credential contents. Keep credentials in ignored `runtime/`, not a source folder.

Grant IDs are unique, including revoked IDs; use a new ID for a new principal.
If grant creation has an uncertain response or saving its credential fails, run
`./agents.sh list` and revoke that ID if present before issuing another grant.
DSG never silently rotates a grant or transfers ownership of its existing holds.

Give the agent this instruction (substitute the actual paths and worker):

> You may use DSG's agent client with the credential at
> `/absolute/path/to/DSG/runtime/agent-credentials/ds4-tester.json` to manage
> `worker-a` for this task. Read status first. Drain it and retain the returned
> `result.hold_id` and request ID. Wait for `gateway_drained:true` before doing
> work that requires the gateway to be clear. When the authorized DS4 test is
> finished and its server is ready, release **your hold** using `resume HOLD_ID`.
> Read status again and report whether routing actually resumed. Do not clear
> another hold, override an operator pause, change other workers, or claim that
> releasing a reservation starts DS4. If cleanup fails, report it explicitly.

Example agent commands:

```sh
export DSG_AGENT_CREDENTIALS=/absolute/path/to/DSG/runtime/agent-credentials/ds4-tester.json
./agents.sh status
./agents.sh drain worker-a --reason "DS4 compatibility test"
# Save result.hold_id from the JSON reply; poll status until gateway_drained.
# Perform only the separately authorized test; DSG does not run it for you.
./agents.sh resume HOLD_ID_FROM_DRAIN
./agents.sh status
```

Every command also accepts `--credential-file ABSOLUTE_FILE` instead of the
environment variable. Operator grant/list/revoke/clear-hold commands must run
without `DSG_AGENT_CREDENTIALS`; this keeps the two channels unambiguous.

## Draining, resuming, and seeing what is live

`status` returns all registered worker IDs and current gateway observations:
health, active count (`load`), `queued`, context, quarantine/recovery flags,
`drained`, `gateway_drained`, `operator_paused`, holds and their owners/reasons.
`can_manage` identifies the grant's permitted workers. It excludes backend URLs,
SSH details, keys and conversation contents. The reply has `observed_at`; it is
a snapshot, not a promise that the machine will remain idle.

- **Drain** stops new admission to that worker; already admitted active and queued
  work finishes. Each accepted drain creates a distinct owned hold. It does not
  cancel, stop DS4, evict caches, change model settings, or move admitted requests.
- **Fully drained** means `drained:true`, no active gateway request and no queued
  gateway requests. Direct clients bypassing DSG are outside that observation.
- **Resume HOLD_ID** releases this agent's hold only. If another hold or an
  operator pause remains, the release succeeds with `routing_resumed:false`.
- Releasing the final hold when no operator pause remains requires a fresh
  compatible model/context probe. A failed probe, quarantine, ongoing recovery
  or gateway shutdown retains the hold. This API cannot clear quarantine or run
  recovery. A model-list probe is not proof of successful future generation.
- **Wake** in this API means *resume routing to an already running DS4 server*.
  Starting a stopped engine or recovering a failed one is a separate capability;
  see [bounded worker recovery](worker-recovery.md).

Old operator pauses are recognized conservatively. If an operator already paused
a worker before an agent acquired its hold, releasing that hold will not enable
it. For an operator-authorized one-off handback of an **existing operator pause**,
use the operator's `./workers.sh resume WORKER_ID` once the test is complete. Do
not give the agent a scoped credential and expect it to erase that manual pause.

In **Manage DS4 servers**, the dashboard names each holding agent, shows its
reason and any operator pause, and disables ordinary Enable/Remove while holds
exist. **Keep paused** adds an operator pause that survives all agent releases.
Reasons are untrusted text, rendered as text, and should contain only a brief
operational explanation—not private prompts or secrets. Genie sees ownership
IDs, not these free-text reasons, and must not treat reservations as failures.

## JSON API contract

All paths below use the existing `control_socket`, with
`Authorization: Bearer <agent-token>`. They are **not** inference TCP endpoints.
Request JSON must have exactly the listed fields; no `force`, commands, URLs,
service names, arbitrary settings or extra authority fields are accepted.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /agent/v1/status` | None | Fleet snapshot, grant scope and last 20 own receipts |
| `POST /agent/v1/drain` | `worker_id`, `reason`, `request_id` | Receipt with `result.hold_id` |
| `POST /agent/v1/resume` | `hold_id`, `request_id` | Receipt with actual `routing_resumed` result |
| `POST /agent/v1/receipt` | `request_id` | Exact committed receipt owned by this grant |

`request_id` is a UUID. `reason` is a nonempty string, at most 256 characters,
without control characters. Mutation requests share the operator/Genie executor
queue. Authentication is rechecked after waiting for it. An agent token sent to
an operator route is rejected; it cannot grant credentials or request recovery.
Body budget is 4 KiB; the supplied client has a 30-second deadline, a 1 MiB
response budget, and **no automatic retries**.

Receipts contain `request_id`, `actor_id`, `action`, `time`, and `result`. They are
saved atomically with the hold/effective pause in the existing private affinity
state. State, holds, grant hashes and receipts survive a gateway restart.
No raw prompts, responses or KV cache contents are added to that state.

## Retries and cleanup

The CLI prints the mutation request ID to stderr **before** sending; save it.
You can supply `--request-id UUID` explicitly for deterministic orchestration.
If the connection is lost, query:

```sh
./agents.sh receipt REQUEST_ID
```

An identical retry with the same request ID returns the committed historical
receipt without reapplying the effect. Changing its action/payload or using
another principal yields `request_id_conflict`. A historical drain receipt does
not imply the hold is still active; inspect current status. A missing receipt
is not permission to send a different action ID—retry the exact original request
ID/payload if still appropriate. Revoked credentials cannot retrieve receipts;
an operator can inspect the private state for reconciliation.

There is **no automatic expiry**: a crashed testing agent must not cause DSG to
resume a server while its test is still running. On an abandoned task, the
operator verifies the real workload, then can:

```sh
./agents.sh list
./agents.sh revoke ds4-tester
./agents.sh clear-hold HOLD_ID
./workers.sh resume worker-a
```

Revocation retains holds. `clear-hold` removes the specified ownership but
deliberately leaves an operator pause; resuming remains a separate checked
operator action. Never use cleanup as evidence that the external test ended.
Removing a worker requires no holds and also removes that ID from grant scopes,
so re-registering the ID does not silently inherit old permissions.

Budgets are 128 lifetime grant IDs, 1,024 active holds and 10,000 retained mutation
receipts. Reaching a budget requires operator review; no silent eviction of holds
or idempotency history. Archival/rotation automation is not implemented.

## Relationship to Gate Genie and other agents

The **executor and worker state are shared; authority is not universal**. Genie
continues using its existing guarded recovery/predictor offers. External agents
receive the small grant above; this change does not grant them service restarts,
predictor changes or control over other agents. Genie does not automatically
receive drain/resume powers. A future MCP wrapper can call this same client/API;
it should not grow a parallel execution path. Remote agents currently need an
operator-approved command environment on the DSG host; there is no LAN admin API.

## Validation and rollback

Automated checks cover scope/ownership, multiple holds, manual-pause precedence,
revoke/abandon cleanup, exact retry receipts, save/probe failure, restart
persistence, private credentials, raw-route denial, preservation of admitted
inference bytes/settings, real dashboard polling and browser hold controls.
They use fake workers, not a claim that a production DS4 recovery was certified.

Back up source and private state before deploying. Once grants/holds are in use,
do not run an older gateway that ignores `agent_control`: it could bypass hold
ownership. Reconcile holds and revoke grants with the current version before an
older-code rollback. Do not restore an old affinity backup over newer sessions
merely to undo a code update.
