# Worker reachability incident — 2026-09-03

This sanitized incident record documents evidence and remaining uncertainty. It
does not attribute the failure to DS4, CUDA, a particular network device or an
operator action without proof.

## Observed sequence

- One Linux worker stopped returning model probes, then its supervised SSH
  tunnel reported server-response and Bonjour-resolution failures. Its active
  SSE response ended incomplete.
- The second Linux worker later lost model-probe readiness. Its tunnel first
  lost name resolution, then reconnected to SSH while the enrolled DS4 port was
  still refusing connections.
- DSG kept restarting only the **tunnels**. It did not reboot either machine,
  restart a model service, delete caches, alter context or replay a partially
  dispatched request.
- Both workers returned without an issued recovery action. The second sequence
  was SSH reachable before its DS4 listener became ready, then passed the normal
  model/context health probe. At the final check both workers advertised the
  configured 262,144-token context and were available.
- A third macOS worker had an older, separate persistent quarantine after its
  endpoint disappeared during admitted requests. It was deliberately not
  readmitted by this incident response because an earlier operator instruction remained
  authoritative.

## What is established

The Linux incident crossed the transport boundary: SSH/name resolution and, for
one interval, the remote DS4 listener were unavailable. There is no persisted
fatal-accelerator evidence for either worker. The existing tunnel supervisor
provided useful self-healing once the hosts returned.

Subsequent SSH inspection established that **both Linux hosts rebooted** during
this interval. Their DS4 services started under the normal systemd boot policy
and reported zero process restarts within the new boot. The previous boot's
kernel logs include NVIDIA `NV_ERR_NO_MEMORY` allocation warnings, including
warnings late in the second worker's preceding boot. These are a lead, not proof
that memory pressure caused either reboot: driver allocation failure can be
recoverable, and the reboot initiator has not been established.

The exact cause of the reboots is **unknown**. Ping without an SSH
or HTTP response is not proof that the host OS, model process or network is
healthy. A model-list timeout while an inference stream is active is also
ambiguous: supported DS4 deployments may serialize that endpoint behind work.

## Hardening derived from the incident

1. A timed-out model probe may be deferred only when the same interval contains
   fresh upstream inference bytes. An `active` flag by itself never overrides a
   failed probe. DSG exports `health_state_source`, `health_probe_deferred` and a
   bounded `probe_error` so Genie can explain this distinction.
2. Tunnel reconnection remains automatic and effect-free on the remote machine.
   It must not be presented as model-service recovery.
3. Genie is told to classify network/SSH reachability separately from a proven
   engine fault. The recovery runner may restart only an enrolled, reachable live
   service with its existing exact fatal-evidence gate. Its separate stopped-service
   path requires the reachable helper's static identity and stopped-epoch proof. It
   must not invent a shell command or reboot an unreachable machine.
4. Starting a known enrolled but stopped systemd-user service is now an optional,
   separately enrolled recovery capability. It requires the exact static service
   profile, a stable stopped epoch, failed gateway readiness, no admitted work and
   no operator pause. Intent-before-effect, lost-acknowledgement and controller-
   restart tests prove no duplicate start. It remains off unless a deployment
   explicitly enrolls `start_stopped`; this incident does not weaken the live
   fatal-fault restart gate or authorize host reboot.
5. Client continuity remains independent. A recovered worker does not by itself
   revive a client turn whose dispatched stream already ended.

## Regression evidence

Tests cover both sides of the probe rule: a model-list timeout accompanied by
fresh inference bytes does not contradict those bytes, while silent active work
does not mask a lost or stalled backend. The existing total-deadline probe test
still fails a trickling, non-model response. Synthetic recovery tests cover stopped
identity drift, pause/admitted-work races, one start per stopped epoch, uncertain
acknowledgment and controller crash reconciliation. A real deployment still needs
the operator-approved stopped-service canary before enabling that power.
