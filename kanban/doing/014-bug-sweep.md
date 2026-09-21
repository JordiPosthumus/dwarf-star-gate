# Bug sweep of ds4-gateway (in progress)
Systematic read of core modules for wiring bugs, stale-data-as-live, duplicated
state, quarantine traps. Found so far:
- FIXED: observer.test stale 'deepseek-v4-flash' assertion (pre-existing failure)
- FIXED: dead performance lights on vLLM workers (removed from card face)
- Suspect: oMLX prefill session-average vs empty chart (card 015)
- Suspect: cache-inventory references missing dir (startup note)
Next: gateway.mjs request paths, door.mjs, recovery paths, media cycle.

Sweep progress (2026-09-21 06:00):
- Cleaned stale references to dead workers in config.local.json: cache_directories
  (m3-studio /tmp path), hardware_telemetry.m3-studio, recovery m3-studio (omlx),
  telemetry_files.m3-studio, genie_chat inspection retargeted m3-studio->glm53f-m3
  (root the DS4-GLM root, same omlx-api-key credential).
- Restarted via park/start; PoolModel generation OK.
- Also noted: 'durable registry differs from private config' note at startup is
  expected (store is source of truth); worth a doc line in card 022.
