# Continuity Door: planned DSG core replacement without abandoning new calls

The Continuity Door is DSG's stable, byte-transparent local client endpoint. New
configurations enable it by default. Applications keep using the public DSG URL
(normally `http://127.0.0.1:30000/v1`); the replaceable gateway core listens on a
different loopback-only port (normally `30001`).

Its narrow purpose is to make a **planned gateway-core restart** uneventful:

1. The lifecycle controller tells the door to hold new inference requests.
2. Their body streams remain paused and unread. DSG does not parse, buffer in
   application memory, or spool the prompt to disk.
3. Existing proxied responses keep streaming while the old core drains.
4. The controller replaces only the DSG core. DS4 servers stay running.
5. The replacement core probes the configured workers and restores durable
   affinity/pause state before it starts listening.
6. The door performs a fresh core health check, then forwards each held request
   exactly once with its original bytes.

The door and core use separate mode-0600 Unix control sockets. The public
`GET /continuity/status` endpoint requires the ordinary DSG bearer key and exposes
only bounded status. The dashboard shows whether the door is ready or holding,
how many unread requests it holds, and how many streams it is proxying. The
headline `WAITING` total combines core-queued and Door-held requests, with the
components named when the Door is holding. Requests that have not yet left a Pi,
Hermes or other client remain outside DSG's observation boundary. Gate Genie
receives the same sanitized facts.

The Door's `failed` count describes proxy transport failures, not every non-200
model response. Client cancellation must settle before socket destruction so it
does not count as a core failure or hold unrelated arrivals. Late error events
from an already-settled proxy must not change admission state. Tests cover both
cancellation timings and genuine upstream disconnects. A lifetime counter alone
does not identify the cause of a particular historical failure.

Door code changes are separate from core changes: a core-only cutover does not
reload this stable endpoint. Update the Door in its own idle maintenance window;
restarting it over active proxied streams would defeat its continuity guarantee.

## Guarantees and boundaries

- Existing proxied streams are not interrupted by a coordinated core restart.
- New held requests receive periodic HTTP 102 informational frames while waiting.
- Request bodies are not persisted, logged, parsed or replayed.
- The door will not release a manual hold until the replacement core passes a
  fresh health check and reports a clean startup barrier.
- The replacement core does not advertise readiness until its worker startup
  probes have completed. A temporarily late SSH tunnel cannot silently turn into
  an incorrect early reassignment merely because the process bound its port.
- If the core disappears unexpectedly, the door automatically holds subsequent
  inference calls. The one connection whose outcome is already ambiguous gets an
  identified `DSG Report:` 503 and is **not** replayed.

This is not a durable message queue and not transparent mid-stream failover. It
cannot reconstruct an answer already emitted, prove that an arbitrarily crashed
DS4 engine did no work, or revive a client that has already closed its socket.
Post-dispatch recovery still needs an explicit client protocol and tool-state
contract. The [client continuity guide](client-continuity.md) covers that separate
problem.

## Configuration

```json
{
  "host": "127.0.0.1",
  "port": 30000,
  "continuity_door": {
    "enabled": true,
    "core_port": 30001,
    "control_socket": "./runtime/continuity-door.sock",
    "startup_probe_ms": 12000
  }
}
```

`port` remains the stable client port. `core_port` must be a distinct loopback
port and is not a client endpoint. Existing configurations without an explicit
`continuity_door.enabled: true` remain in direct mode; upgrades do not silently
move a live listener. Run `npm run doctor` before activation.

On macOS, `./start-dsg.sh` installs and verifies the gateway core, Continuity Door
and dashboard. A normal `npm run service -- restart gateway` keeps the door alive,
drains the old core, checks the replacement, and releases held work. `--interrupt`
still means exactly that and is not continuity-safe.

For a deliberate longer core outage, run `./park-dsg.sh`. It keeps the Door and
dashboard running while it drains and stops only the core. A later ordinary
`./start-dsg.sh` starts and verifies the core, then releases only the exact park
hold. It does not release an unrelated operator hold. Full `./stop-dsg.sh` still
stops the Door and therefore cannot preserve live continuity.

The automated tests cover unread-body backpressure, exact single forwarding,
active-stream preservation, held-client cancellation, release refusal while the
core is unhealthy, clean-checkout first start, and replacement-core startup.
