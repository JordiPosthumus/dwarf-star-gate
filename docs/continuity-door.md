# Continuity Door: planned DSG core replacement without abandoning new calls

The Continuity Door is DSG's stable, byte-transparent local client endpoint. New
configurations enable it by default. Applications keep using the public DSG URL
(normally `http://127.0.0.1:30000/v1`); the replaceable gateway core listens on a
different loopback-only port (normally `30001`).

Its narrow purpose is to make a **planned gateway-core restart** uneventful:

1. The lifecycle controller tells the door to hold new inference requests and
   `GET /v1/models` discovery requests, including those with query parameters.
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

Discovery shares the existing bounded hold capacity and cancellation cleanup;
it is forwarded once, unchanged, after release. Health and gateway status reads
still pass through and can return a 503 during core downtime. Authenticated
`GET /continuity/status` is served by the Door itself, even while the core is off.
Only a running Door reporting `model_discovery_hold: true` has this protection;
syncing source or restarting only the core does not activate it.

The Door's `failed` count describes proxy transport failures, not every non-200
model response. Client cancellation must settle before socket destruction so it
does not count as a core failure or hold unrelated arrivals. Late error events
from an already-settled proxy must not change admission state. Tests cover both
cancellation timings and genuine upstream disconnects. A lifetime counter alone
does not identify the cause of a particular historical failure. New Doors also
expose `failure_evidence`: process-lifetime counters for inference, model discovery,
status and other requests, plus the latest 30 failure receipts, newest first.
Each contains a sequence, timestamp, fixed request class, before/after-response-
headers phase, and hold state at failure. No paths, queries, request bodies,
credentials or backend error text are retained in these receipts. The dashboard
and Genie receive a bounded, allowlisted projection; older missing evidence is
unknown, not zero failures. This evidence resets when the Door restarts.

A status-poll failure is not an inference-session loss. Neither response phase
establishes whether a backend executed the request: every receipt explicitly says
`backend_dispatch: unknown` and grants no replay permission. Failures already
counted by an older Door cannot be classified retrospectively.

Readiness checks have their own lifecycle: concurrent callers share one in-flight
probe, and hold/release transitions invalidate earlier observations. A healthy
reply from before a connection failure cannot release the resulting newer hold.
Likewise, a pending release check cannot override a newer operator reservation.
Only a fresh successful check may release an automatic hold; healthy probes never
release manual holds by themselves.

Lifecycle releases also carry `if_hold_id`, the unique receipt returned by the
hold/status response. The Door checks this receipt **before and after** the health
probe. Replacing a hold creates a new receipt even when its reason text is the
same; an older operation gets `continuity_hold_changed` and cannot release the
replacement. A receipt is not a credential: the private control socket still
provides authority. An explicit operator release may omit the condition and keeps
its existing health check. Automation never falls back to unconditional release.

**Upgrade order:** a running Door must advertise `hold_ownership: 1` before the
updated lifecycle controller can coordinate a core restart or release a parked
core. Older Doors cannot enforce this condition. Upgrade the Door in an **idle,
unheld** maintenance window first; do not stop it over active or held client
requests. The controller refuses an unsupported restart before placing a hold or
stopping the core. If a core was already parked under an older Door, its normal
start can start the core but leaves the hold intact: an operator must inspect and
explicitly release it before arranging the Door upgrade. There is no automatic
hold override or forced client interruption during version migration.

Truncated responses, aborts and errors settle the health probe as failed rather
than leaving readiness pending forever. `health_timeout_ms` (default 1,500 ms)
bounds the whole small health probe, including a dripping/incomplete response,
not just socket inactivity. Overlapping checks count one result, not multiple
failures. Shutdown cancels pending probes without recording another failure.
This deadline is **not an inference, queue or Genie timeout** and does not cancel
or replay model requests.

Door code changes are separate from core changes: a core-only cutover does not
reload this stable endpoint. Update the Door in its own idle maintenance window;
restarting it over active proxied streams would defeat its continuity guarantee.

## Guarantees and boundaries

- Existing proxied streams are not interrupted by a coordinated core restart.
- New held inference and discovery requests receive periodic HTTP 102
  informational frames while waiting.
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
