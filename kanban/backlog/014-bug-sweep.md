# Bug sweep of ds4-gateway
Systematic read of core modules (gateway, dashboard, door, genie, media) for:
wiring bugs (like the dead performance lights), stale data shown as live, duplicated
state, error paths that would quarantine innocent workers.
Known suspects from the 2026-09-21 session:
- performance lights dead for endpoint workers (being removed in card rewrite)
- oMLX prefill "session average" scope vs live chart mismatch (card shows 752 t/s
  session avg above an empty 15m chart)
- media-hosts kind validation would reject adding M3 (missing kind)
Output: findings filed as kanban cards; fixes landed with tests.
