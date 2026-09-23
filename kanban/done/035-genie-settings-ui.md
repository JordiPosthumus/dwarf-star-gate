# Genie Settings in the UI + max thinking for the GLM fleet

Owner request, 2026-09-22: Genie should run on "max" thinking for the GLM model,
and Genie settings should be configurable from the dashboard UI instead of
config files.

## LANDED 2026-09-22 ~21:50 (see commits)

Applied immediately (owner-requested, recorded here):

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

- [x] Store-backed Genie thinking level (chat + reviewer) following the
      established pattern (queue_timeout_ms / conversation_turns): saved value
      in the gateway store, config value as fallback, default shown honestly.
      Control route + management action + CSRF, like the other settings.
- [x] Settings section "Genie" (inside the Genie capabilities panel): thinking level selector (none … max) with
      current value and source (saved/config/default); applies to the next chat
      turn / review without editing files; survives restart.
- [x] Surface the existing per-capability switches (the panel IS the capability surface; thinking sits beside it) in the same section if not
      already visible there (fleet_power, server_changes, rebalance, recovery,
      media, spark_setup, hourglass) so Genie behavior is configured in one place.
- [x] Tests: store persistence round-trip, restart survival, control validation
      (bad levels rejected), UI renders current value.

Done: an owner can set Genie thinking to max (or any level) from the dashboard,
and the running Genie picks it up on the next turn/review.

Landed:
- `/set-genie-thinking` control route: validates the 7-level set, saves to the
  gateway store (`genie_thinking`), logs the change; stats() reports effective
  chat/reviewer levels with the saved source as fallback to config defaults.
- Dashboard applies the saved value live: the Hermes chat provider config and
  the fleet reviewer endpoints (dedicated + fallback) are mutated in place, so
  the next chat reply / review uses the new level without a restart; the same
  apply runs from the first gateway poll at startup (survives restarts).
- UI: "Genie thinking" block in the Genie capabilities panel — chat and fleet
  review selectors + Apply, current effective values and scope shown, changes
  confirmed honestly ('the next reply/review uses …').
- Suite 1106 pass / 0 fail (197 gateway tests).

Deployment note: dashboard-side live (2026-09-22 late). The `/set-genie-thinking`
route and stats field live in the gateway core, which serves continuous
household traffic tonight — the core park/start reload (door holds calls, no
model restart) is deferred to the next quiet window. Until then the selectors
hide themselves honestly (no saved state in the snapshot) and the effective
levels remain the config values (chat max, reviewer max) applied at startup.