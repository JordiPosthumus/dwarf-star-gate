# GLM pair recovery: transaction and verification

The pair transaction, detached controller connection, evidence-bound enrollment
and GLM cache verifier are implemented components. Explicit enrollment and native
restart qualification are still required for each pair. Enabling the existing recovery switch does not enroll a
GLM pair. A successful paired-media return is evidence for that operation, not
general service-recovery certification.

## Exact pair transaction

`recovery_pair.py` accepts a private enrollment with two distinct native machine
identities, exact container IDs, complete normalized Docker definitions, image
identities, mounted-file hashes and modes, and the head recipe files. Context and
concurrency must match the pinned head environment. The configured head port,
model and worker ID are part of the enrollment fingerprint. A rank without its
own recipe directory is supported; its mounted configuration remains pinned.
Native pair machine identities combine the existing Linux machine-ID hash with
the sorted physical GPU UUIDs. This distinguishes factory-cloned OS installations
without rewriting their machine IDs. Missing or changed GPU identity refuses;
different SSH aliases alone never prove different physical hosts. Earlier
machine-ID-only pair captures require a fresh capture before enrollment.

Restart requires current native fatal-accelerator evidence or an explicitly
authorized canary. Starting requires both exact containers to be stopped. An
initial partial pair, unknown state, paused/restarting container, changed machine,
changed image, changed command/environment/mount or changed file refuses. Recovery
does not recreate containers, download models, pull images or rewrite settings.

The transaction stops head then rank and starts rank then head. Every native
command follows a durable intent. A lost acknowledgement leaves an uncertain
operation. A subsequent observation may advance that same operation only when
the exact native state proves the pending step; it never repeats an uncertain
command. An ownership interruption waits under the same action ID. A conflicting
operation or external peer restart cannot be adopted silently.

`recovery_pair_native.py` supplies fixed SSH commands, strict host-key checks,
native listener ownership, timestamped CUDA evidence, bounded file snapshots,
private atomic/fsynced journals and an exclusive OS file lock. The fixed `recovery-pair.py` bridge starts a detached runner using an exact saved
request and an exclusive native lease. Before each native command it requests a
fresh permit over the owner-only gateway Unix socket and checks native running
and waiting counters while the head is live. Missing metrics, changed ownership
or an unavailable controller prevents the next command. A stopped pinned head
cannot admit direct work; its remaining transaction can continue after ownership
returns. Transaction completion means the
containers returned, not that serving, cache reuse or routing admission passed.

## GLM generation and cache verification

The `glm53_vllm` recovery verifier checks the enrolled model's current context
metadata, then runs cold A, cold B, warm A and warm B. Each cold prompt must have
at least 16,384 tokens and zero cached tokens. Each warm result must retain a
nonshrinking history and reuse at least 4,096 tokens, with at most 8,192 tokens of
the original prefix uncached. Ordered usage samples are retained in a distinct
GLM proof; Qwen and DS4 receipts cannot substitute for it.

These synthetic requests retain the server's template/thinking defaults and the
actual returned assistant messages. `max_tokens=4096` applies only to the check
requests; it is not a production output cap. No cache is reset. The check does not
exercise maximum context, output or concurrent-request boundaries, certify
container identity, or measure an isolated performance benefit.

Actual Genie can run this verification independently of a restart using
`verify_serving` with `check="glm-cache"`, the configured worker ID and one action
UUID, then observe `admission_status`. The worker must already be healthy,
admitted and free of ownership holds. The diagnostic requires an exact configured
paired-media binding, served model and current context; it does not enroll
recovery or change routing. Existing action IDs retain their results and are not
replayed after dashboard interruption.

## Evidence and remaining acceptance

Tests exercise every lost-acknowledgement boundary, file/configuration drift,
ownership continuation, cross-process lock exclusion and abrupt process exit
after a simulated native transition. Those are fixture results, not a Spark
restart qualification. The bridge tests also use real detached processes, process exit and a private
Unix socket with simulated Docker transitions. Controller tests reconstruct the
controller, resume the same request, preserve shared-machine reservations and
exercise temporary ownership holds. Native restart acceptance must still bind
fresh hardware identities, demonstrate the complete installed path, execute the
GLM verifier and admit routing only after exact identity and owner-state checks.


## Explicit controller enrollment

Genie can prepare fresh evidence with `prepare_pair_recovery(worker_id)` for an
existing configured media pair. The tool resolves the current registered route,
uses only its configured native targets, reads both members twice and pins the
second read to exact container IDs. Machine, epoch, Docker definition or file drift
refuses preparation. A healthy owned head listener and matching native capacity
are required. This is read-only on the fleet; active inference is not interrupted.

The detached collector retains full observations privately under the runtime
directory's `genie/recovery-pair-preparation/<action_id>`. `recovery_status` exposes
bounded `pair_preparations` receipts, not Docker environments or host paths.
`prepared` means a stable capture exists in `evidence.json`; it neither installs
recovery enrollment nor qualifies a restart. Its `evidence_sha256` hashes the
canonical JSON value using `recovery_pair.fingerprint`. Keep the same action ID
when observing a lost acknowledgement. `preparing` requires a live native file
lease; an absent lease without a receipt is `unverified`, never assumed complete
or automatically replayed. Existing receipts survive dashboard restarts.

Keep the full private enrollment outside the repository. Its wrapper has exactly
`schema: 1`, `enrollment` (the pinned pair described above), `journal_directory`
(an absolute, owner-only directory) and `gateway_socket` (the current owner-only
control socket). Preserve the enrollment and its source observations as rollback
evidence. The controller hashes the complete private file bytes; any change
requires explicit re-enrollment. Native inspection is read-only and does not grant
enrollment or mutation authority.

Add an explicit entry to the private `recovery.workers` configuration with:

- The registered worker's exact `id`, `url`, `backend` and, for a tunnel route,
  its existing `ssh` and `remote_port`. A direct HTTP worker keeps its current
  serving URL and has no routing SSH fields; the private pair enrollment supplies
  its native SSH targets. Its native head port must match the endpoint port.
- `adapter: "docker-pair"`, `transport: "local"`, `verification: "glm53_vllm"`
  and `exclusive: true`.
- Absolute paths for `python`, the repository's `ds4-gateway/recovery-pair.py`
  as `helper`, and the private wrapper as `config`. Keep the helper with its
  adjacent shipped modules. Linux and macOS controllers are supported.
- `machine` and `profile` from `recovery_pair.enrollment_identity(enrollment)`,
  and `pair_config_sha256` equal to the SHA256 of the complete wrapper file.
- An exact two-member physical-machine mapping, shared with every alias using
  either machine. Serving limits must match the pinned native enrollment.

Stopped starts remain unenrolled by default. Explicit `start_stopped: true` also
requires `service_profile` equal to the enrolled pair profile. Native commands
can only start or stop those existing containers; no image pull, rebuild,
recreation, launcher rewrite or model-file deletion is available.

Automatic recovery requires a completed operator restart canary for this exact
configuration, physical mapping, context and concurrency. The existing private
`/recovery-canary` control requires the worker to be paused first, another physical
LLM to remain available, current ownership and native idle evidence. It leaves
the worker paused after native generation/cache verification. A controller must
record all four native transaction steps and a changed final pair epoch before
that receipt can qualify automatic recovery. A stopped-start or externally
restarted replacement alone cannot substitute for this canary.

While an operation is unresolved, the controller reserves both physical members
and their registered aliases against inference dispatch. New aliases sharing the
same mapping inherit that reservation. Owner pauses, other holds and active work
continue to block native commands. Temporary holds retain the same durable action
and resume observation after they clear; a failed proof or changed identity stays
reserved for explicit reconciliation. Current native identity and a distinct GLM
proof are required before routing admission. No public HTTP or chat endpoint can
issue a native step permit.

The standalone diagnostic has been exercised through actual Genie on two configured
pairs: four cold histories reported zero cached tokens and four warm histories
reused 14,336 tokens from approximately 19,750-token initial prompts. This validates
the diagnostic on that fleet, not the new detached restart path or another owner's
hardware. Native restart receipts remain the acceptance gate for enabling that path.

Pair capture completion is followed automatically in its originating Genie
conversation. The dashboard reads saved preparation tool handles, waits for native
terminal receipts, and durably submits one read-only follow-up when Genie is idle.
It resumes after a dashboard restart and deduplicates a lost chat acknowledgement
using the same saved request ID. Already observed results and superseded captures
need no extra reply. Missing or uncertain evidence never causes a new capture.
Stopped replies, paused conversations, testing mode and disabled inspection prevent
automatic follow-up. If the follow-up finishes without reading the terminal tool
receipts, `recovery_status.pair_preparation_followup` reports `needs_attention`;
a model answer alone does not count as observed evidence. This watcher grants no
enrollment or restart authority and does not qualify general pair recovery.

## Genie enrollment from retained native evidence

An owner can explicitly allow enrollment for configured pairs in private config:

```json
{
  "pair_recovery_setup": {
    "workers": {
      "my-glm-pair": { "exclusive": true }
    }
  }
}
```

`exclusive` is the owner's declaration that DSG may manage this exact service.
It is not inferred from an empty queue. Use the existing paired-media binding,
physical-machine mapping and registered route for the worker; no private host
names, paths or commands belong in a Genie request. Inspection, server changes
and automatic recovery must also remain enabled. Other owners supply their own
worker IDs, configured Python, native SSH bindings and runtime directory.

For a prepared capture, Genie calls `enroll_pair_recovery(worker_id, capture_id)`.
The core saves the action ID before starting native validation. Fixed code checks
capture/request/evidence hashes, physical GPU identity, current registered binding
and capacity, then reads both exact native members twice. Container-name retargeting,
configuration/file drift, a new pair epoch, missing evidence or conflicting prior
enrollment refuses the request. Current ownership and the saved route/capacity are
checked again immediately before commit.

The owner-only wrapper and native journal live beneath the configured runtime
folder. The core takes a timestamped metadata backup, atomically records the
binding and restores it on subsequent starts. Queued validation retains its action
ID across restart; re-observation is read-only. An uncertain acknowledgement must
be inspected under that same ID, never submitted with a replacement ID.
`recovery_status.pair_enrollment.operations` reports `queued`, `enrolled` or
`failed`. The completion watcher returns to the original conversation when a
terminal receipt is available and records whether Genie actually read it.

Enrollment preserves existing recovery entries, routing, operator pauses and all
model settings. It does not stop/start anything or authorize stopped starts.
Automatic pair recovery still requires the separate exact native restart canary
and GLM generation/cache proof. `enrolled` is not `restart-qualified`. The default
installation has no opted-in workers, and disabling setup prevents new enrollment
without removing an already saved recovery definition.
