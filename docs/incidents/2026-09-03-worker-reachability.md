# Worker reachability: diagnostic boundaries

This reusable guide retains diagnostic lessons without an operator's incident
chronology. The existing document link is retained for compatibility.

## Distinguish the failed layer

- DNS or Bonjour failure does not establish a model-engine fault.
- SSH reachability does not establish that the enrolled DS4 listener is ready.
- A connected tunnel is not proof of model identity or inference readiness.
- An active request flag alone is not proof of continuing inference progress.
- A timed-out model-list probe can be ambiguous when a backend serializes it
  behind inference. Fresh upstream bytes in the same interval are stronger
  evidence than the active flag alone.
- Accelerator allocation warnings are a diagnostic lead, not proof of a reboot
  cause. Inspect separate boot, service and kernel evidence before attributing it.

## Bounded recovery

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
   explicitly enrolls `start_stopped`; this capability does not weaken the live
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
