# Genie Settings in the UI + max thinking for the GLM fleet

Owner request, 2026-09-22: Genie should run on "max" thinking for the GLM model,
and Genie settings should be configurable from the dashboard UI instead of
config files.

## Applied immediately (owner-requested, recorded here)

- `genie_chat.reasoning_effort`: high → **max** (Genie chat via Hermes).
- `config.genie.reasoning_effort: "max"` and `config.genie.fallback.reasoning_effort:
  "max"` added — the fleet reviewer previously defaulted to 'high' in code
  (genie.mjs `endpoint.reasoning_effort ?? 'high'`); the dedicated and pool
  fallback review endpoints now explicitly request max.
- Takes effect after a dashboard reload (both are dashboard-side configs; no
  core or model-server restart). Worker serving-profile defaults
  (chat_template_kwargs per-worker DS4 request rules) are a separate mechanism
  and are NOT touched by this card.

## UI work: Genie Settings section (Settings tab)

- [ ] Store-backed Genie thinking level (chat + reviewer) following the
      established pattern (queue_timeout_ms / conversation_turns): saved value
      in the gateway store, config value as fallback, default shown honestly.
      Control route + management action + CSRF, like the other settings.
- [ ] Settings tab section "Genie": thinking level selector (none … max) with
      current value and source (saved/config/default); applies to the next chat
      turn / review without editing files; survives restart.
- [ ] Surface the existing per-capability switches in the same section if not
      already visible there (fleet_power, server_changes, rebalance, recovery,
      media, spark_setup, hourglass) so Genie behavior is configured in one place.
- [ ] Tests: store persistence round-trip, restart survival, control validation
      (bad levels rejected), UI renders current value.

Done: an owner can set Genie thinking to max (or any level) from the dashboard,
and the running Genie picks it up on the next turn/review.
