# Bounded DS4 service recovery

Implemented, **off by default**. Gate Genie can request recovery of an eligible
worker; a deterministic watcher uses the same runner for confirmed fatal faults
without waiting for an LLM review. The runner, adapter, UI and tests are in this
repository. No Pi or Hermes installation is required.

## Enrollment: start here

Giving this task to your local coding agent? Start with
[Enroll a DS4 server — instructions for your agent](agent-recovery-enrollment.md).
It separates inspection, explicit permission, private setup and verification.
This document is the detailed adapter/configuration reference.

**Connecting a server for inference does not enroll it for recovery.** The UI's
automatic-recovery switch controls already enrolled services; it does not install
an adapter or grant service permissions. There is not yet a browser enrollment
wizard. A `manual recovery required` row can mean the worker lacks a matching
private enrollment, not that its inference endpoint is unusable.

1. Identify the existing install: [Linux systemd user service](#install-on-another-systemd-user-deployment),
   [Mac user LaunchAgent](#install-on-an-explicitly-enrolled-macos-launchagent), or
   unsupported/manual. For a Mac running DSG itself, also follow
   [same-host transport](#same-host-mac-transport-explicit-enrollment).
2. Keep automatic recovery off while installing the fixed helper and private
   configuration. Use the applicable section below; do not replace your working
   launcher or copy another owner's machine paths/fingerprints.
3. Run **read-only inspection**, then record the verified service identity in
   `recovery.workers` inside ignored `config.local.json`. This is separate from
   the ordinary inference-worker list. Choose restart-only or separately opt into
   loaded-but-stopped start. Removed Mac jobs are not recoverable yet.
4. Apply the configuration at an agreed DSG reload, then reserve an idle worker
   for the **operator canary**. This test really restarts/starts the enrolled
   service and leaves routing paused; it is not a harmless connection test.
5. Check the completed receipt, unchanged effective settings and both cold/warm
   results before explicitly resuming routing and enabling automatic recovery.

Endpoint connected, identity enrolled, and recovery verified are three different
milestones. The current UI does not provide a per-worker setup checklist or certify
all of them with a single green badge. Use the
[validation checklist](recovery-validation.md) and retain its receipts privately.

## What it does—and does not do

The production-canary adapter is **Linux systemd user services**, tested with a
native DS4 service on DGX Spark. A separate **macOS launchd LaunchAgent adapter**
implements the same private protocol and has synthetic identity, fault, exact-job,
idempotency and no-repeat tests. It is not automatically enrolled and has not yet
completed a public-repository real-Mac canary. Each Mac must pass its own private
inspection and operator canary before automatic recovery is enabled. These are
install-type boundaries, not hardware checks. Manually launched processes,
LaunchDaemons/system jobs and containers remain manual. Adding an endpoint in the
UI does not grant permission to start or restart it.

Running-process restart recovery requires all of the following:

- An operator-enrolled worker/service, verified SSH host key for remote transport
  or an explicitly enrolled same-host Mac transport, matching physical
  machine fingerprint, exact service-owned loopback listener, executable and
  runtime/configuration fingerprint. The profile includes binary, launcher,
  declared configuration files, effective service definition and runtime command.
  The systemd profile also includes DS4 environment; launchd hashes the enrolled
  plist and declared files because macOS does not expose another process's full
  environment through this helper.
- Exclusive use of that endpoint through DSG, explicitly acknowledged in private
  configuration. DSG cannot see or safely arbitrate unrelated direct clients.
- A persisted fatal/checkpoint quarantine, no admitted active/queued work, and
  current-invocation backend evidence of illegal CUDA memory access or a
  device-side assertion. A generic checkpoint message alone does **not** authorize
  a restart. Successful decode progress after the error invalidates that evidence.
- No manual pause, no other fleet recovery, one attempt per failed instance or
  stopped epoch, and
  a minimum 30-minute per-worker cooldown. Recurrence is an alert, not a loop.

It restarts exactly one configured `systemctl --user` service or one configured
`launchctl kickstart` LaunchAgent. It never reboots,
resets the GPU, deletes caches, replaces models, rewrites launch settings, lowers
context/output/thinking/concurrency, or cancels a merely slow xhigh response.
**A restart necessarily loses RAM-resident cache state.** Disk caches are not
deleted; normal DS4 service shutdown may save/checkpoint state as usual.

If a new compatible invocation already started after the quarantined failure,
the runner verifies it without redundantly restarting it. This replacement-only
readmission applies to fatal faults and repeated operational/stream failures: the
new exact-profile invocation is the safety boundary, and the deterministic watcher
can act without waiting for Genie prose. Unchanged failed instances, unknown profiles,
unreachable SSH, unsupported faults and uncertain ownership stay isolated for operator
review.

An optional second path can start a **loaded but stopped** instance of that same exact
systemd service. It is separately off by default and requires `start_stopped:true` plus
an enrolled `service_profile`: a static fingerprint of the machine, exact unit,
executable, declared profile files and listener port that remains verifiable without a
live PID. DSG must observe the same stopped epoch for at least 15 seconds, the gateway
worker must be failed, idle and unpaused, and normal one-operation/30-minute guards still
apply. A missing unit, changed file, open listener, active process or unknown install is
never started. Endpoint registration alone grants no such authority. The 2026-09-03
[reachability incident](incidents/2026-09-03-worker-reachability.md) is the acceptance-test
basis; it does not authorize a reboot or turn a network outage into service evidence.

Both helpers check port availability even when the enrolled service has no PID.
They briefly bind, without reuse, connecting or listening, to IPv4 and supported
IPv6 loopback addresses. A wildcard listener or bound non-listening socket also
blocks start; socket-inspection errors are not treated as an empty port. For an
inactive service, the protocol's `listener:true` is conservatively an occupied-port
veto, not proof that the enrolled DS4 process owns it. All probe sockets close
before returning. This is a sampled guard, not an atomic port reservation through
service launch; exclusive ownership and maintenance coordination still matter.

Readiness requires unchanged advertised context/model and configuration, exact
synthetic answers, then **two conversations cold-to-warm**, with numerical cached
token evidence. The four checks use approximately 2,200 prompt tokens each and
32-token output allowances, with thinking disabled **only on those synthetic
requests**. This is not a long-context/vision certification or a kernel bug fix.
Real clients retain their original limits and reasoning requests unchanged.

An already failed client response is not repaired or silently replayed. A client
may need to retry/continue. Transparent recovery after partial output/tool calls
requires a separate client-cooperation design.

## Operator controls and receipts

The dashboard has a **DS4 service recovery** section:

- **Enable/Disable automatic recovery** persists across DSG service restarts.
  It authorizes both GG requests and the known-fatal watcher. The GG commentary
  switch is separate; a configured Genie now starts on unless private config
  explicitly sets `genie.enabled` to `false`.
- **Recover** is available only for a currently eligible worker. Operator recovery
  can be requested with automatic mode off; the same identity/evidence guards apply.
- **Recheck only** observes an uncertain/failed issued operation and reruns its
  verification. It **never issues another start or restart**.
- The timeline shows executor receipts: actor channel, worker, action ID, actual
  state, error and cold/warm counts. GG's prose and “request accepted” are not
  evidence that recovery completed. `actor` names the trusted ingress channel,
  not an authenticated human identity among processes sharing the same OS user.

The worker row shows its **current** recovery/paused/quarantined/monitoring state.
An older `verified_paused` receipt means the action finished while paused, not that
the worker is still paused after an operator resumes it. Historical receipts are
not rewritten when current routing state changes.

Worker readiness and management reachability are separate evidence. DSG exposes
only a sanitized management-path state and bounded reason class: for example DNS,
host-key, authentication, connection timeout/refusal/reset, route unreachable,
or a helper-contract failure. `ssh_process_active` proves only that a local SSH
process exists; `verified` means the DS4 model probe succeeded through that path.
The dashboard tooltip and Gate Genie briefing use these distinctions without
publishing aliases, addresses, usernames or raw SSH output. A transport failure
never becomes engine-fault evidence and never authorizes a service restart.

Service identity/profile drift is reported even while the worker still has
admitted work. An active queue is temporary; a changed binary, launcher,
environment, declared profile file or unit definition requires deliberate
re-enrollment and a new canary. DSG does not hide that durable gate behind
`wait_for_admitted_work`, and it never trusts the new fingerprint automatically.

The dashboard health wire does not depend on a successful Genie inference to
surface this state. A quarantined worker or an enabled worker failing readiness
produces a deterministic live alert with fleet availability and held-request
counts; fresh Genie commentary may add context but cannot suppress the alarm.
Intentional operator pauses and scoped agent maintenance holds are not faults.

### Handing back a worker after maintenance

An idle-looking worker is not sufficient evidence for automatic readmission.
There are two deliberately different control paths:

- A scoped maintenance agent releases only its own hold. If that was the final
  hold, no operator pause remains and the worker is not quarantined, DSG performs
  a fresh compatible model/context probe before routing can resume.
- A quarantined, legitimately changed service can enter verified profile hand-back
  only when automatic recovery and the hand-back sub-policy are enabled. DSG must
  independently see the same enrolled machine and service binding, an active exact
  listener, the same changed profile and instance in two inspections at least ten
  seconds apart, no admitted work, and either current fatal evidence or a new
  invocation after quarantine. The fixed executor then verifies model/context,
  generation and two cold-to-warm conversations before readmission.

An operator pause, named maintenance lock or another agent hold vetoes both paths.
Gate Genie cannot erase any of them, and elapsed idle time never turns a reservation into permission. The
full operator `workers.sh resume WORKER_ID` command can deliberately clear an
operator pause; it is operator authority, not a Genie action. Processes sharing
the same unrestricted OS user are not individually authenticated on that channel,
so maintenance agents should use scoped holds. The stronger
[named durable maintenance lock](maintenance-locks.md) also blocks broad Resume,
survives restart and requires exact release; a review deadline only warns.

**Verified profile hand-back** handles a legitimate upgrade that changed the
enrolled runtime fingerprint. Its separate sub-policy defaults on, but it is
dormant unless automatic recovery itself is enabled. The adapter must report the
same enrolled machine and configured service transport, an active exact listener,
and one identical changed profile/instance in at least two inspections separated
by ten seconds. DSG additionally requires no admitted work and either a service
invocation started after the quarantine or current fatal accelerator evidence.

The candidate fingerprint is never accepted from Genie, an agent or the browser.
The executor passes the independently inspected fingerprint back only to the
already enrolled helper, issues no service action for an already replaced
invocation, and otherwise restarts only that exact service. Model/context, fresh
generation and two cold-to-warm conversations must pass before the private
adoption and readmission commit together. The adoption survives controller
restart, is invalidated if the operator changes the base private enrollment, and
is represented publicly only as a bounded state/receipt—not a hash.

If an inspection cannot prove a new static stopped-service profile, DSG does not
carry the old value forward. Live verification/restart may still complete, but a
later start-from-stopped remains disabled until that static identity is explicitly
re-enrolled. Unknown evidence never becomes inherited authority.

An operator pause, named maintenance lock or scoped agent hold blocks hand-back.
An agent with a scoped credential can reserve a Spark for optimization before
work and release it only when ready for DSG verification. An external test can
instead use a maintenance lock with an advisory review time; overdue locks remain
held until exact operator release. This version never steals another actor's live
reservation.

Pause/removal wins over final reinstatement. Turning automatic mode off stops new
automatic actions and cancels a proposal before issuance when possible; an issued
restart continues reconciliation/verification. Do not assume a sent SSH command
can be recalled. Other workers continue serving.

The gateway owns execution, so a dashboard/Genie restart does not abandon it.
Intent and outcomes are atomic/fsynced metadata in the existing private affinity
store. The remote helper also persists intent before issuing a service action, with
an idempotency record per action and failed instance/stopped epoch. Lost acknowledgments
and controller restarts cause observation/reconciliation, never blind resubmission.
After a 15-minute replacement-readiness deadline, uncertainty stays isolated.
Either journal stops accepting new operations at 10,000 entries; it never silently
deletes recovery history. Routine logs also record sanitized stage transitions.

The runner detects a current service/configuration change and stops for review;
upgrading DS4 requires deliberate re-enrollment, not an automatic trust update.
No prompts, answers, raw backend log lines, SSH credentials or host paths are
included in public status/diagnostic recovery receipts. Machine/profile hashes
and service configuration stay in private enrollment/state.

## Install on another systemd-user deployment

Use Python 3.10+ on the server and Node 22.22.2+ on the gateway. The normal gateway
still needs only Node; the optional adapter uses Python's standard library.
Do this per worker, initially with automatic mode **off**.

1. Verify the DS4 service, healthy generation, existing configuration and that
   **all inference clients use DSG**. Back up files and pause/drain before a canary.
   Use one recovery registration per physical machine in this first version.
2. Install `ds4-gateway/recovery-systemd.py` on the server, in an operator-owned
   private directory, beside a mode-0600 configuration like the following. Replace
   every example path with the actual paths; include every sourced settings file.
   The service's main PID must be the DS4 executable (launchers should `exec` it).

   ```json
   {
     "unit": "ds4.service",
     "port": 8000,
     "binary": "/opt/ds4/ds4-server",
     "profile_files": ["/opt/ds4/run.sh", "/opt/ds4/settings.env"]
   }
   ```

3. Run the read-only adapter inspection over the same verified SSH alias used
   by the registered worker. Send `{"action":"inspect"}` on stdin to:

   ```text
   python3 /opt/dsg/recovery-systemd.py /opt/dsg/private.json
   ```

   Require `active:true`, `listener:true`, the expected service identity and no
   fault. Record the returned `machine`, live `profile`, and static `service_profile`
   hashes in private gateway config; do not paste them or your private installation
   paths into a public issue. Capturing the static hash while healthy does not enable
   stopped-service start by itself.
   A remote worker may declare up to four `ssh_fallbacks`. Each value is another
   preconfigured, host-key-verified OpenSSH alias for the **same machine**—not an
   address accepted from a request and not an SSH option. Inspect the machine over
   every alias before enrollment. A static DHCP reservation or private overlay
   network is generally a better fallback than an unverified changing address.
4. Add an enrollment entry (illustrative placeholders, intentionally not runnable):

   ```json
   {
     "recovery": {
       "workers": [{
         "id": "worker-a",
         "url": "http://127.0.0.1:38001",
         "ssh": "my-ds4-server",
         "ssh_fallbacks": ["my-ds4-server-lan", "my-ds4-server-tailnet"],
         "remote_port": 8000,
         "adapter": "systemd-user",
         "exclusive": true,
         "helper": "/opt/dsg/recovery-systemd.py",
         "config": "/opt/dsg/private.json",
         "machine": "REPLACE_WITH_INSPECTED_SHA256",
         "profile": "REPLACE_WITH_INSPECTED_SHA256"
       }]
     }
   }
   ```

   This is restart-only. After its canary passes, a deployment may opt in the exact
   stopped-service path by adding the following two fields to that worker entry:

   ```json
   {
     "start_stopped": true,
     "service_profile": "REPLACE_WITH_INSPECTED_STATIC_SHA256"
   }
   ```

   Never infer either value from the HTTP endpoint or a failed health probe. ID/URL/SSH
   aliases/port must match the registered worker. Recovery paths are absolute,
   shell-safe paths without spaces in v1. Endpoint registration cannot alter this
   separate allowlist. Copying the config does not apply it to a running process.

   For an existing remote registration, update the fallback list without
   remove/re-add by using its **Routes** control in the local UI, or:

   ```text
   node ds4-gateway/workers.mjs fallbacks worker-a --ssh-fallbacks my-ds4-server-lan,my-ds4-server-tailnet
   ```

   The optimistic, backed-up write changes only host-key-verified fallback aliases.
   It does not interrupt the current tunnel or alter inference/model settings; the
   tunnel supervisor reads the latest durable list on its next reconnect. Use
   `clear-fallbacks worker-a` to return to the primary alias only.
5. Restart DSG at an agreed maintenance window. Inspect the
   policy/UI. The monitor inspects services every 30 seconds; ordinary inference
   and health-check timeouts are unchanged. Unreachable adapters do not block the
   inference event loop or restart anything.
6. With an idle, manually drained worker, run the operator-only canary. On a healthy
   service it deliberately restarts that service. With separately enrolled
   stopped-service support and a stable failed/stopped observation, the same command
   issues exactly one start. Either path **leaves routing paused** after verification;
   automatic recovery itself never overrides an operator pause.

   ```sh
   node ds4-gateway/recovery-control.mjs status
   node ds4-gateway/recovery-control.mjs canary worker-a
   node ds4-gateway/recovery-control.mjs status
   ```

   The CLI reads `config.local.json`, or `DWARF_GATE_CONFIG`. Follow the executor
   receipt; do not equate the command's accepted response with completion. Check
   the native effective settings and proof, then explicitly enable worker routing.
7. Opt in using the UI or `node ds4-gateway/recovery-control.mjs auto on`.
   The model receives only eligible worker/evidence pairs. Its validated JSON
   `recovery_requests` field is the action interface, not arbitrary shell and not
   an external Pi/Hermes bot. The gateway independently refreshes evidence before
   executing, so a stale review or forged pair cannot bypass policy.

## Install on an explicitly enrolled macOS LaunchAgent

The launchd helper is deliberately **not** a generic process launcher. It supports
only a user LaunchAgent already loaded in `gui/$UID/<label>` for the SSH account.
It does not load plists, target LaunchDaemons, accept commands, edit settings or
discover a service from an HTTP endpoint. The LaunchAgent's reported PID must be
the configured DS4 binary and must own the configured loopback listener.

**Loaded-and-stopped is not removed.** If macOS removes the LaunchAgent job,
`kickstart` cannot restore it. A launcher that registers a temporary plist and
then deletes that plist is outside this adapter's removed-job recovery boundary.
This can occur after a graceful OS-directed termination, not only after a model
fault. An idle GPU or successful prior canary does not supply missing bootstrap
authority. Restore the established launcher manually and verify it before
readmission; do not clear quarantine just because the process starts.

Inspection now distinguishes three bounded diagnostic blocks:

- `launchd_registration_absent`: the service was reported missing twice around
  a successful inspection of the exact GUI domain. A job appearing in between is
  inspected as loaded instead. This does not establish why the job was removed.
- `launchd_gui_domain_unavailable`: the GUI domain could not be found, not proof
  of a DS4 engine crash. Inspect login/session state with the operator.
- `launchd_state_unverified`: other failed or unfamiliar inspection evidence;
  absence is not proven. Unknown state is not reported as `loaded:false`.

These reasons reach Genie and the deterministic quarantine alert. They never
create a recovery offer, bypass a pause or authorize bootstrap. The fixed helper
uses observed `launchctl` exit codes and checks domain output conservatively;
Apple does not promise `print` output as a stable API. Changed formats/codes remain
unverified and require per-installation validation, not permissive parsing.

**Native macOS disable instructions also win.** The launchd helper reads the exact
service's override from `launchctl print-disabled gui/$UID`. An explicit disable
blocks starts, restarts, canaries and automatic readmission; DSG never issues
`enable` to clear it. Unreadable, malformed or duplicate override evidence is
unknown, not consent. The executor checks again after saving its intent receipt;
a changed disable setting prevents command issuance and blind reissue. The
controller also rechecks fresh inspection evidence before an action, before
generation verification and before committing readmission or profile adoption.
This covers stopped starts, canaries, already-replaced instances and persisted
reconciliation, not just the initial recovery offer. Disabled or unknown policy
at these checkpoints retains quarantine and does not adopt the new profile.
These are sampled checks, not an atomic lock over an operator's concurrent
launchctl action; they do not instantly cancel an already-running generation test.

The bounded status reasons are `launchd_native_disabled` and
`launchd_disable_state_unverified`; Genie and quarantine alerts explain them.
Upgrade the **enrolled Mac helper as well as the gateway** before validating this
capability: older helpers omit the required `native_disabled` evidence and remain
ineligible. Linux adapters are unaffected. No live helper is installed automatically.
An absent override means only that this particular native veto was not found;
it does not prove that a prior bootout/stop was accidental or authorize bootstrap.
DSG pauses, agent holds, identity checks and all other recovery gates still apply.

The controller now retains one **private last-identity observation per enrolled
Mac worker** in its existing recovery state. It records the exact PID, instance,
start time, machine/profile/static identity and an enrollment-binding digest only
after a matching active service-owned listener inspection with no reported fault.
An optional private boot companion is bound to that complete record's digest;
legacy identity records remain readable without it. This is identity evidence,
not a generation-health certificate. The timestamp is
when that identity was first retained, not a continuously refreshed liveness clock.
Unchanged polls do not rewrite it; a newly observed identity replaces this single
snapshot. Existing action journals are untouched. No prompts, output, paths or
identity digests are added to public status or Genie briefs.

The observation survives controller restart and an absent/failed inspection;
changed enrollment bindings make it unusable. A missing, malformed or failed
write cannot seed later removal evidence. Historical identity alone never creates
a recovery offer or authorizes a start. Direct native removal diagnostics are now
joined to retained PID/boot evidence; explicit restoration policy, command-time
stop-intent vetoes and retained-definition bootstrap remain unfinished.

The [native removal auditor](macos-removal-provenance.md) now checks archived
launchd records by exact structured subsystem, PID, boot and time window. It
distinguishes a caller observation from unknown intent and rejects incomplete
captures. The updated enrolled helper can also query macOS directly when a job
is absent; the controller rate-limits these diagnostics and gives bounded results
to Genie. Neither an archived result nor a direct capture creates a recovery offer.

The [retained-definition agent preflight](macos-retained-definition.md) now checks
an optional private content pin without rewriting the plist or issuing commands.
It preserves XML/binary bytes and returns bounded diagnostics with no action
authority. It does not prove that a guessed plist matches an existing launch.

Planned support for this case needs separate opt-in enrollment of an exact,
private, retained service definition;
verified GUI domain, machine, binary/profile and empty listener; durable one-shot
bootstrap receipts; and a real removed-job recovery canary with cold/warm reuse.
Operator pauses, maintenance holds and explicit stop intent must block automatic
bootstrap. Missing or changed definitions must remain ineligible. Do not substitute
an arbitrary launcher command, create a login item or move to a LaunchDaemon as
an implicit fallback. These capabilities are **not implemented by this adapter**.

Process metadata checks the kernel executable path before and after reading the
command, and rechecks the reported process start time. A changed start time is
rejected even if a reused PID runs the same binary. These are sampled identity
checks, not an atomic launchd compare-and-restart operation; maintenance
coordination and the per-installation canary remain mandatory.

1. Keep automatic recovery off. Verify that every inference client uses DSG,
   back up the LaunchAgent/plist/launcher configuration, and choose a maintenance
   window for a later canary. Do not use a Mac reserved for another test.
2. Install `ds4-gateway/recovery-launchd.py` on the Mac. Beside it, create an
   operator-owned mode-0600 JSON configuration. Include every file that determines
   the model-server launch. `log_file` is optional, but without a timestamped stock
   DS4 engine log the adapter cannot prove a current fatal accelerator fault and
   therefore cannot automatically restart a still-running process.

   ```json
   {
     "label": "com.example.ds4",
     "plist": "/absolute/path/to/Library/LaunchAgents/com.example.ds4.plist",
     "port": 8001,
     "binary": "/absolute/path/to/ds4/ds4-server",
     "profile_files": [
       "/absolute/path/to/ds4/start-ds4.sh",
       "/absolute/path/to/ds4/settings.env"
     ],
     "log_file": "/absolute/path/to/ds4/runtime/engine.log"
   }
   ```

3. Over the same host-key-verified SSH alias used by the worker, send only
   `{"action":"inspect"}` to the helper. Require `active:true`, `listener:true`,
   the expected label/binary/port identity and no fault. Record the returned
   `machine`, `profile` and `service_profile` digests only in ignored private DSG
   config. Never publish them with paths or SSH details.
4. Add a private worker enrollment using the same registered ID, tunnel URL, SSH
   aliases and port. The paths below are illustrative, not defaults:

   ```json
   {
     "id": "mac-worker",
     "url": "http://127.0.0.1:38003",
     "ssh": "my-mac-ds4",
     "remote_port": 8001,
     "adapter": "launchd",
     "exclusive": true,
     "helper": "/absolute/path/to/dsg/recovery-launchd.py",
     "config": "/absolute/path/to/dsg/recovery.json",
     "machine": "REPLACE_WITH_INSPECTED_SHA256",
     "profile": "REPLACE_WITH_INSPECTED_SHA256"
   }
   ```

   Stopped-service start remains separately opt-in with `start_stopped:true` and
   the exact inspected `service_profile`, just like systemd. A loaded-but-stopped
   state must remain stable for 15 seconds before one start can be offered.
5. At an agreed window, reload DSG source/config, drain the Mac, and run the
   operator-only canary. The helper durably records intent before invoking exactly
   `launchctl kickstart -k gui/$UID/<label>`. DSG then requires unchanged model and
   context plus real generation and two cold-to-warm conversations before recording
   success. The canary leaves routing paused; inspect the receipt and explicitly
   resume only after the native launch settings are independently confirmed.
6. Only after that private canary should the operator consider automatic mode.
   A timeout or lost SSH acknowledgement is reconciled by process-instance identity;
   DSG never blindly repeats `kickstart`. Keep the enrollment disabled on any Mac
   whose GUI domain, binary ownership, listener, log timestamps or profile is not
   proven.

### Same-host Mac transport (explicit enrollment)

If DSG and DS4 run on the same Mac, an entry may instead use
`"transport":"local"` with `"adapter":"launchd"` and an absolute `"python"`
interpreter path. Omit `ssh`, `ssh_fallbacks` and `remote_port`; retain the exact
registered worker URL, exclusive-ownership assertion, machine/profile digests,
helper/config paths and separate stopped-service opt-in. The helper configuration's
port must match the registered local endpoint. Omitting transport retains the
existing SSH behavior; a failed remote connection never triggers local execution.

Before each local call DSG requires a non-root macOS account, regular non-symlink
interpreter/helper/config files owned by that account or root, no group/world
write permission, and an account-owned mode-0600 helper config bounded to 64 KiB.
Use canonical interpreter paths rather than symlinks. Paths with spaces are
literal arguments: DSG invokes the enrolled interpreter with Python isolated mode
(`-I`), helper and config, with no shell; action JSON travels only on stdin.
Genie cannot select any of these paths. Local diagnostics are bounded reason
codes, not subprocess stderr or private paths. Helper results are read through
pipe closure, including bytes delivered after process exit.

`adapter_local_unavailable` means the caller is not a supported non-root macOS
account. `adapter_local_identity_unverified` means a file, permission, config or
port check failed before execution; inspect private enrollment locally. Neither
reason supplies authority to change permissions or substitute an interpreter.

The same identity, pause, ownership, idempotency and cold/warm canary gates still
apply. This transport does **not** add removed-job bootstrap, enroll an existing
installation automatically, install a login item or change DS4's launcher. A
private real-Mac canary is still required before automatic recovery is enabled.

## Security and operational limits

The SSH account and gateway OS user are trusted operator principals. The helper
does not turn an existing broad SSH key into a sandboxed credential; GG never
receives that key or shell access. Stronger deployments may provision a dedicated
forced-command key. Normal SSH host-key verification is mandatory; first-time host
trust must be established out of band, not accepted by the recovery code.

This first helper recognizes specific fatal CUDA log signatures for a live-process
restart. The stopped-service path instead requires the separate exact static enrollment;
it is not triggered by arbitrary errors, temperature, memory pressure, transport outages
or lengthy thinking.
It reads at most 200 current-invocation journal records and rejects an oversized
inspection. Missing/mismatched evidence means no restart. Do not broaden its
matches merely to make a red status disappear. Missing/mismatched static identity
likewise means no stopped-service start.

To roll back: disable automatic recovery, wait for or reconcile any issued action,
then restore prior source/config after an agreed gateway restart. Preserve current
affinity, quarantine, newer operator pauses and both action journals. Never restore
an old whole affinity file over live session changes as a routine rollback.

## Tests and evidence

`npm test` covers policy, live/static identity drift, forged GG requests, pause races,
cooldown, idempotency, lost acknowledgment, crash-resume without a duplicate start or
restart, verification failures, real local
HTTP orchestration and CSRF/no-public-action boundaries. `npm run recovery:test`
tests both Python helpers' exact-service issuance, profile compatibility,
intent-before-effect behavior, current-instance fatal signature matching, exact
stopped epoch/static identity and no-repeat guards. The launchd tests also cover
private no-follow config/history/log handling and exact `gui/$UID/<label>` commands.

These tests use synthetic services. A live canary checks actual service restart,
unchanged profile/context and real generation/cache reuse; it does **not** inject
a CUDA fault or establish that the underlying accelerator defect is fixed.
The systemd deployment has such a canary; launchd still requires a private real-Mac
canary before it may be described as validated for that installation.

Use the [recovery validation procedure](recovery-validation.md) to check your
enrollment, cold/warm reuse, preserved settings and policy persistence. Keep the
resulting deployment receipts private.
