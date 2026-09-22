# Extract affinity persistence into a small tested module

Pending, lower priority than household functionality and fleet controls. The
PID-reuse outage fix is already deployed in #032; this card is cleanup, not an
unfixed outage or a prerequisite for other features.

- Move AffinityStore, lock ownership and saved-state validation out of gateway.mjs
  into one small module. Preserve a compatibility export if existing callers need it.
- Preserve state format, lock semantics, atomic writes, fsync, corrupt-state handling,
  routing and all capabilities. No storage migration, new dependency or framework.
- Reuse the existing lock/gateway tests; verify persisted sessions and operator
  settings round-trip and a live owner cannot be displaced.
- Deploy through the usual drained core reload and #016 checks. No model restart.

Done: a smaller gateway file with unchanged externally observed behavior and
passing persistence/gateway tests. Do not broaden into a gateway rewrite.
