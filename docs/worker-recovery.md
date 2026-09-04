# Bounded DS4 service recovery

Implemented, **off by default**. Gate Genie can request recovery of an eligible
worker; a deterministic watcher uses the same runner for confirmed fatal faults
without waiting for an LLM review. The runner, adapter, UI and tests are in this
repository. No Pi or Hermes installation is required.

## What it does—and does not do

The first adapter is **Linux systemd user services**, tested with a native DS4
service on DGX Spark. This is an install-type boundary, not a hardware check.
Macs remain ordinary supported inference workers; automatic **launchd recovery
is not implemented**. Manually launched processes and containers require manual
service recovery until a tested adapter exists. Adding an endpoint in the UI does
not grant permission to restart it.

Recovery requires all of the following:

- An operator-enrolled worker/service, verified SSH host key, matching physical
  machine fingerprint, exact service-owned loopback listener, executable and
  runtime/configuration fingerprint. The profile includes binary, launcher,
  declared configuration files, effective systemd unit, argv and DS4 environment.
- Exclusive use of that endpoint through DSG, explicitly acknowledged in private
  configuration. DSG cannot see or safely arbitrate unrelated direct clients.
- A persisted fatal/checkpoint quarantine, no admitted active/queued work, and
  current-invocation backend evidence of illegal CUDA memory access or a
  device-side assertion. A generic checkpoint message alone does **not** authorize
  a restart. Successful decode progress after the error invalidates that evidence.
- No manual pause, no other fleet recovery, one attempt per failed instance, and
  a minimum 30-minute per-worker cooldown. Recurrence is an alert, not a loop.

It restarts exactly one configured `systemctl --user` service. It never reboots,
resets the GPU, deletes caches, replaces models, rewrites launch settings, lowers
context/output/thinking/concurrency, or cancels a merely slow xhigh response.
**A restart necessarily loses RAM-resident cache state.** Disk caches are not
deleted; normal DS4 service shutdown may save/checkpoint state as usual.

If a new compatible invocation already started after the quarantined failure,
the runner verifies it without redundantly restarting it. Missing/stopped services,
unknown profiles, unreachable SSH, unsupported faults and uncertain ownership
stay isolated for operator review. V1 does not start an arbitrary stopped install.
The stopped-service extension is intentionally not inferred from a lost listener:
it first needs a static enrolled-service identity proof that remains verifiable
without a live DS4 PID. The 2026-09-03 [reachability incident](incidents/2026-09-03-worker-reachability.md)
is the acceptance-test basis; it does not broaden the current restart authority.

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
  verification. It **never issues another restart**.
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

Pause/removal wins over final reinstatement. Turning automatic mode off stops new
automatic actions and cancels a proposal before issuance when possible; an issued
restart continues reconciliation/verification. Do not assume a sent SSH command
can be recalled. Other workers continue serving.

The gateway owns execution, so a dashboard/Genie restart does not abandon it.
Intent and outcomes are atomic/fsynced metadata in the existing private affinity
store. The remote helper also persists intent before issuing a restart, with an
idempotency record per action and failed instance. Lost acknowledgments and
controller restarts cause observation/reconciliation, never blind resubmission.
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
   fault. Record the returned `machine` and `profile` hashes in private gateway
   config; do not paste them or your private installation paths into a public issue.
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

   ID/URL/SSH aliases/port must match the registered worker. Recovery paths are absolute,
   shell-safe paths without spaces in v1. Endpoint registration cannot alter this
   separate allowlist. Copying the config does not apply it to a running process.
5. Restart DSG at an agreed maintenance window. Inspect the
   policy/UI. The monitor inspects services every 30 seconds; ordinary inference
   and health-check timeouts are unchanged. Unreachable adapters do not block the
   inference event loop or restart anything.
6. With an idle, manually drained worker, run the operator-only canary. It restarts
   the healthy service deliberately and **leaves it paused** after verification.

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

## Security and operational limits

The SSH account and gateway OS user are trusted operator principals. The helper
does not turn an existing broad SSH key into a sandboxed credential; GG never
receives that key or shell access. Stronger deployments may provision a dedicated
forced-command key. Normal SSH host-key verification is mandatory; first-time host
trust must be established out of band, not accepted by the recovery code.

This first helper recognizes specific fatal CUDA log signatures, not arbitrary
errors, temperature, memory pressure, transport outages or lengthy thinking.
It reads at most 200 current-invocation journal records and rejects an oversized
inspection. Missing/mismatched evidence means no restart. Do not broaden its
matches merely to make a red status disappear.

To roll back: disable automatic recovery, wait for or reconcile any issued action,
then restore prior source/config after an agreed gateway restart. Preserve current
affinity, quarantine, newer operator pauses and both action journals. Never restore
an old whole affinity file over live session changes as a routine rollback.

## Tests and evidence

`npm test` covers policy, identity drift, forged GG requests, pause races, cooldown,
idempotency, lost acknowledgment, crash-resume, verification failures, real local
HTTP orchestration and CSRF/no-public-action boundaries. `npm run recovery:test`
tests the Python helper's exact-service issuance, intent-before-effect behavior,
current-invocation fatal signature matching and no-repeat guard.

These tests use synthetic services. A live canary checks actual service restart,
unchanged profile/context and real generation/cache reuse; it does **not** inject
a CUDA fault or establish that the underlying accelerator defect is fixed.

Use the [recovery validation procedure](recovery-validation.md) to check your
enrollment, cold/warm reuse, preserved settings and policy persistence. Keep the
resulting deployment receipts private.
