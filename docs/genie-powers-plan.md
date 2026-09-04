# Gate Genie powers: recovery, model stewardship and operator controls

Status: **bounded systemd recovery, an opt-in launchd adapter, and predictor stewardship implemented; broader powers below remain a design**.
The authoritative shipped scope, setup, controls and limits are in
[bounded worker recovery](worker-recovery.md): private systemd-user or launchd
enrollment, one guarded runner shared by GG and a fatal-fault detector, durable
receipts and verified reinstatement. Systemd has a real deployment canary; launchd
requires a per-installation canary before activation. Container adapters, editable
Genie endpoints, persistent chat remain future work. Predictor training/rollback, fixed promotion
gates and operator switches are specified in [the shipped lifecycle](predictor-lifecycle.md).
The sections below
retain the original broader plan; they are not a claim that every item shipped.
A running process is not upgraded merely by changing files on disk.

The [persistent memory plan](genie-memory.md) adds a private evidence-linked
notebook, not a new source of permissions or training labels. It remains planned;
the current in-memory report list is not a durable operational memory.

## Division of responsibility

- **XGB:** predicts service cost from a versioned request/worker feature contract.
- **DSG scheduler:** applies deterministic compatibility, ownership, health and
  routing rules, and eventually combines predicted service time with waiting and
  cache costs. Optional new-session placement uses only qualifying validated XGB
  artifacts; experimental artifacts never control routing.
- **Genie:** interprets evidence, requests approved operational actions, and
  stewards XGB training/calibration. It does not invent telemetry, choose commands
  or override hard routing constraints.
- **Action runner:** executes a small allowlist after independent checks; records
  receipts and verification. It must work without an LLM for known fatal faults.

Keep the feature contract and promotion tests fixed outside the Genie's control.
Genie may request bounded XGB candidate training and tuning, including tree-count
cross-validation, but cannot change its own acceptance gates. Choosing among
pre-approved features versus adding new feature extractors remains an operator
policy decision. Turning Genie off leaves collection, the last approved model
and deterministic fallback routing intact.

## How the CUDA incident could have recovered automatically

1. Observe a structured accelerator error, isolate the affected worker and
   retain the triggering request ID. Successful `/v1/models` probes must not
   override generation failure evidence.
2. Resolve whether this is a restartable fatal execution fault: obtain bounded
   backend logs and process/service identity, and correlate the error to the
   **current** process instance. A generic checkpoint error alone can justify
   quarantine but is not proof that a service restart is the right cure.
3. Genie can request recovery with the evidence IDs; a deterministic trigger may
   request the same operation without waiting for a five-minute LLM review.
4. The runner checks that recovery is enabled for that worker, the process is
   still the failed instance or the separately enrolled service is stably stopped,
   no other recovery owns it, and the retry budget is available. A slow healthy
   xhigh response is not service-action evidence.
5. Start or restart exactly the configured model service as authorized by that
   evidence, preserving model weights,
   launcher/environment, context/output, concurrency and disk caches. Losing
   RAM-resident checkpoints is an explicit unavoidable consequence. No reboot,
   GPU reset, cache deletion, container replacement or kernel patch is implicit.
6. Wait for readiness; check unchanged advertised capabilities and configured
   launch settings; perform real generation and cold-to-warm continuation checks
   on the isolated endpoint. Reinstatement requires actual success, not merely a
   new PID or an HTTP-200 model list.
7. Re-enable routing only if verification passes and the operator has not paused
   or removed the worker meanwhile. Emit a verified receipt and concise UI
   commentary. Failure leaves it quarantined and raises an operator alert.

This would restore a recoverable poisoned process, **not repair the CUDA kernel
bug**. Recurrence should collect evidence for diagnosis, not trigger endless
restarts. The already failed client response is not erased: automatic continuation
after partial streamed text/tool calls is a separate client-cooperation feature.

## Small v1 operation contract

One operation: `recover_worker(worker_id, evidence_id, action_id)`. The evidence
offer binds either the expected live instance or stopped epoch inside DSG. These
are structured identifiers, never shell fragments.

- Resolve host, transport and exact service unit from operator-owned config.
  Genie cannot supply an endpoint, command, environment variable or service name.
  Use the existing authenticated transport with verified host keys. The executor
  receives only the authority required for its configured service operation;
  broad SSH access and control credentials are never handed to model prompts.
- Current-instance identity is stronger than today's endpoint/model/context
  fingerprint: include the process start/service invocation identity. Old log
  entries must not authorize restarting a new healthy process.
- Keep one active recovery per worker; the fleet limit is one recovery at a time.
  Retry policy is one automatic attempt per failed instance or stopped epoch,
  with a minimum 30-minute per-worker cooldown between automatic attempts. Early
  recurrence stays quarantined for operator review. These are proposed recovery
  bounds, not inference limits or permission to mutate production defaults.
- Persist intent before issuing a restart and results afterward in a small private
  action journal; record actor (`operator`, `genie`, `detector`), IDs, policy
  version, evidence, timestamps and sanitized before/after observations. No raw
  conversation text or credentials. Do not add another database for this slice.
- Include existing register/drain/resume/remove controls in the action trail,
  not only future recovery. Record channel and correlation ID; distinguish
  authenticated identity from a caller's self-reported label. Today's control
  log has no caller attribution. An inference-client configuration change must
  not be translated into removing that client's backend from the fleet.
- Duplicate action IDs return the same operation. If the controller crashes or
  SSH times out after sending restart, reconcile service invocation identity
  before doing anything else. Never blindly send restart again on reconnect.
- A disconnected client does not prove its backend execution stopped. Known fatal
  process recovery may abandon that process's failed work under explicit policy;
  uncertain/possibly healthy work remains isolated pending investigation.
- Already queued, never-dispatched requests follow documented gateway rejection
  and retry behavior. Do not silently replay requests whose execution may have
  started or transfer a session while ownership is unresolved.
- Operator pause/remove wins over recovery completion. The action runner must
  check current state immediately before re-enabling routing. Its failure or the
  Genie's failure must not block unrelated workers.

Minimal operation states: proposed, rejected, queued, restarting, verifying,
recovered, failed, reconciliation-needed. State transitions describe actual
execution, not assertions produced by the LLM.

### Portable deployment boundary

The runner, policy checks, audit receipts and UI belong in this repository;
host-specific identity and service-action authority belong in private configuration.
Registering a DS4 HTTP endpoint alone must never grant start/restart authority. A
worker without a configured adapter remains observable/routable, but its UI
must explicitly say **manual service recovery required** when quarantined.

Adapter setup must verify that the configured service actually owns the DS4
listener being registered, not merely that some endpoint advertises the expected
model name. Record both the live service/process identity and the static unit,
binary, declared-files and port profile that remains checkable while stopped;
check the applicable association again before recovery. A manually launched
process, an unknown service manager, or a mismatched service/endpoint stays in
manual-recovery mode. Differences in context, quantization and hot/disk cache
settings are valid: preserve each installation's own verified profile, not a
universal Spark preset.

The typed `systemd-user` and `launchd` adapters support exact fatal-instance
restart and a separately opt-in exact stopped-service start, using configured SSH
aliases and one enrolled service identity. A container adapter could target an exact existing container service. It would need the
same bounded operations: inspect instance/config identity, obtain fault evidence,
restart that instance's service, and inspect readiness. The common runner performs
DS4 generation/cache verification and routing reinstatement. Do not claim platform
support until that adapter has integration tests and a real deployment check.

No operator's usernames, IPs, filesystem paths or SSH credentials ship as defaults.
Transport permissions are provisioned by the installer. No arbitrary shell field,
remote bootstrap, cache deletion or service reconfiguration is exposed to Genie.
Thus another installation can use the same recovery logic without copying this
deployment's credentials or assuming its hardware/service manager.

An alive-but-CUDA-failed process explains why `Restart=on-failure` is insufficient:
systemd sees a running process, while DSG sees failed inference. The proposed
runner bridges that gap. It must also report errors during shutdown/cache save;
a new PID alone is not a successful recovery receipt.

## UI: current controls versus proposed controls

**Current:** the Gate Genie panel beside Evidence collection has Enable / Turn
off, Dedicated server / DSG pool fallback, Review now and Ask. Once configured,
it starts on after a dashboard restart unless private config sets `enabled:false`.
The dropdown selects already configured endpoints;
it is not a URL editor. Endpoint/model/auth/tunnel settings live in the private
configuration's `genie` and `genie.fallback` blocks. Changes currently require a
dashboard restart; changing only Genie settings does not require a model restart.

**Proposed next controls:**

- **Genie on/off** for reasoning and commentary, separate from a visible
  **Automatic worker recovery** opt-in and per-worker recovery permissions.
  Known-fault isolation remains active when the optional Genie LLM is off.
  Display both states so off never misleadingly implies all automation stopped.
- **Endpoint settings** within the panel: local/tunneled API URL, model, optional
  secret, primary/fallback choice, and explicit SSH alias/remote-port setup if
  needed. Preserve loopback-only endpoint validation and authenticated tunnels;
  no arbitrary proxying or silent cloud fallback. Blank credentials remain valid
  for unauthenticated local DS4. Never echo stored secrets to the browser.
- **Test connection** first (API/model compatibility), then an explicitly labelled
  small generation test. Neither test grants recovery powers. Save atomically,
  keep the previous working config on failure, and never switch mid-review.
  Source changes must not alter worker registration or ordinary inference.
- **Action timeline**: target, actor, reason, evidence, queued/running/verified
  state, elapsed time and failures. Separate Genie commentary from executor
  receipts. Include an operator-triggered Recover control and an evidence drawer.
- **Worker badges** distinguish manually paused, quarantined, restarting,
  verification failed and available. Persist why/when/who; do not call a
  quarantined server idle or count it as immediately usable capacity.
- **Chat and feedback:** persistent question/assessment threads, linked to action
  and evidence IDs. Useful/wrong/resolved feedback is annotation, not fabricated
  ground truth for XGB. Operator override and disable controls stay accessible.

Turning off automatic recovery stops new recovery actions. If a start or restart is
already issued, do not abandon reconciliation or verification halfway through;
finish in a safe isolated state and make that distinction explicit in the UI.
Do not promise an already-issued remote command can be cancelled.

## Test plan and acceptance evidence

1. **Deterministic tests:** allowlist/policy checks; fresh versus stale process
   evidence; duplicate action IDs; live/stopped identity; one-recovery ownership;
   cooldown; operator
   pause/remove races; no new jobs dispatched to quarantined workers; failure
   leaves isolation intact; successful model-list alone never reinstates.
2. **Transport/crash tests:** SSH unavailable, bad host key, timeout before/after
   command acceptance, process already restarted, controller crash at each
   operation boundary. Verify reconciliation prevents duplicate starts/restarts.
3. **Adversarial model tests:** malformed tool calls, injected log instructions,
   invented evidence IDs, wrong worker, attempts to change context or caches,
   false "I fixed it" commentary. No unapproved effect; UI remains truthful.
4. **Recovery integration tests:** fake HTTP-healthy/inference-broken service;
   failed generation, missing usage/cache evidence, truncated answer, slow load,
   second fatal fault and exhausted budget. Synthetic/fake coverage validates
   orchestration, not actual DS4 GPU recovery.
5. **One real canary:** with operator permission and a drained worker, perform an
   ordinary controlled service restart. Check launch/config fingerprints, model,
   context/output, real generation and exact-prefix cold-to-warm reuse; retain
   receipts. Do not deliberately induce illegal memory access on production to
   test the controller. Unobserved fatal-error paths remain explicitly unproven.
6. **UI/privacy tests:** on/off and permissions, endpoint validation, secret
   redaction, failed save rollback, stale status, actions survive dashboard
   restart, restricted exports and accessible state labels. Feedback cannot
   promote a predictor or clear quarantine by itself.

## Staged deployment

1. Activate and verify the tested DSG quarantine release first. Record exact
   public commit and live process version; preserve existing configs and affinity.
2. Ship recovery in **shadow mode**: capture structured proposals and explain
   denied/eligible actions, but issue no service commands. Review real evidence.
3. Enable **operator-triggered recovery** for one configured worker. Run the real
   canary and verify rollback/disable controls before granting automatic authority.
4. Opt in **automatic known-fatal recovery** on that one worker. Observe real
   incidents and unexpected actions; require verification receipts, not a target
   number of contrived crashes. Expand worker by worker only after review.
5. Expose the same bounded operation to Genie. More ambiguous diagnoses can remain
   proposals while deterministic known-fatal recovery runs independently.

Each step is a small documented commit with tests and live activation recorded
separately. Rollback disables new recovery actions and restores the previous
runner code; it does not erase quarantine, newer session affinity or the audit
journal. Model configurations, ordinary context and output settings stay intact.
