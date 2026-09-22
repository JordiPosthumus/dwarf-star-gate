# Review genie-chat-balancing + genie-load-balancing settings
config has genie_load_balancing + genie_rebalance_min_wait_ms; pickuphere says gate
architecture leaves the operator with more work than intended. Audit what the Genie
already rebalances automatically vs what still needs the operator.

## AUDITED (2026-09-22 ~03:30)
Automatic (no operator action needed):
- Scheduler: spare concurrent slots go to new independent work; FIFO within a
  conversation; conversation turn allowances yield to the oldest other chat.
- Automatic queued relocation ('scheduler' actor): an undispatched first/unaffined
  or wait-expired queued request moves to an idle healthy destination (~1s tick,
  gateway.mjs rebalanceUndispatched → relocateQueued).
- Direct-reserve soft exclusion: reserved worker deprioritized; scheduler
  relocation fills it only when the rest of the pool is busy.
- Genie-authorized rebalance ('genie' actor, rebalance capability ON): queued
  moves when source queue >=2 or wait >= genie_rebalance_min_wait_ms (60s).
Still operator work:
- Pausing/resuming workers (drain/resume), quarantines (verify & readmit),
  adding/removing workers and routes (park/start restart), power scripts —
  the last two now have Genie chat tools with ask-first approval.
Config: genie_load_balancing=true, automatic_affinity_rebalance_min_wait_ms
defaults 300000 (5 min escape), genie_rebalance_min_wait_ms=60000.
Verdict: matching Jordi's intent — routine balancing is automatic; policy-level
moves stay conversational. No config change needed.