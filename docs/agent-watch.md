# Agent Watch

Agent Watch is an opt-in, advisory bridge between a local client harness and
Dwarf Star Gate. It addresses one narrow blind spot: DSG normally cannot tell
whether a quiet Pi/Hermes run is executing a local tool, waiting before its next
provider request, or has already placed work in DSG.

## What it reports

The implemented Pi adapter sends a heartbeat every 15 seconds using the same DSG
URL and bearer credential already used for inference. Each heartbeat contains
only:

- schema version and a fresh random run UUID;
- client kind (`pi`), a monotonic sequence and process-liveness boolean;
- one coarse state: `local_tool`, `waiting_for_model`, `idle`, or `done`.

The gateway records receipt time itself and correlates the UUID with only the
coarse lifecycle of the latest tagged DSG request: received/queued, dispatched,
or terminal. Public status and the dashboard contain a salted 12-character
pseudonym, never the UUID or DSG request ID. State is memory-only, bounded to 256
runs and removed after 24 hours or a gateway restart.

It never sends or stores the task, prompt, messages, images, tool name, tool
arguments, tool output, model answer, working directory, file path or session
transcript. The extra header is stripped before stock DS4. The endpoint accepts
strict JSON up to 2 KiB and has no routing or control operation.

The reporter permits only one outstanding heartbeat. Ticks while it is pending
are coalesced; the next tick reports the latest state. A heartbeat expires after
15 seconds, and changing or ending a session cancels its obsolete heartbeat.
This bounds disposable telemetry during a Continuity Door hold. Inference and
Genie review deadlines are unaffected. Missing heartbeats remain unknown.

## Enable it for Pi

Load the supplied, explicitly scoped extension as described in
[client continuity](client-continuity.md), and set:

```sh
export DSG_AGENT_WATCH=1
```

The extension still wraps only the named `DSG_PI_PROVIDER` at the exact
`DSG_PI_BASE_URL`. It does not edit Pi settings or provider definitions. The
client's existing DSG API key remains only in memory and is reused for the
heartbeat; deployments exposed beyond loopback need the same TLS/private-network
protection as inference traffic.

## What the diagnoses mean

- **Local tool active:** the client explicitly reported local tool execution.
- **Waiting inside DSG:** the tagged request reached this gateway and is not yet
  dispatched.
- **Model response active:** DSG dispatched the tagged request.
- **No request reached DSG:** the live client reported `waiting_for_model` for at
  least 20 seconds, but no tagged request reached this gateway process. Check the
  client's provider selection, transport and local retry state. This is not proof
  that the process is frozen or that a DS4 server failed.
- **Heartbeat stale · state unknown:** DSG has not heard from the adapter for 45
  seconds. Silence is deliberately not classified as death or a hang.

Gate Genie receives the same bounded evidence and may explain it. The current
implementation is advisory only: it cannot submit input, interrupt, nudge, retry,
revive or control Pi/Hermes. Any future revival adapter is a separate opt-in
capability requiring current evidence, an idempotent action and a visible receipt;
silence alone will never grant authority.
