# Bug sweep of ds4-gateway (in progress)
Systematic read of core modules for wiring bugs, stale-data-as-live, duplicated
state, quarantine traps. Found so far:
- FIXED: observer.test stale 'deepseek-v4-flash' assertion (pre-existing failure)
- FIXED: dead performance lights on vLLM workers (removed from card face)
- Suspect: oMLX prefill session-average vs empty chart (card 015)
- Suspect: cache-inventory references missing dir (startup note)
Next: gateway.mjs request paths, door.mjs, recovery paths, media cycle.
