# Context limits and rolling upgrades

DSG distinguishes **a server's native capacity** from **the pool's advertised
minimum**. Registering a server does not change its DS4 launch arguments.

| Setting or observation | Owner | Automatic? |
| --- | --- | --- |
| Native total context (`--ctx`) and default output allowance (`--tokens`) | Each DS4 server's launcher | No; DSG never edits or restarts model servers |
| Worker `context_length` in gateway status / server management | Observed from that server's `/v1/models` | Yes, on startup, registration and periodic health probes |
| Pool limit and client-facing `/v1/models` context | UI's explicit saved setting; startup `context_length` is the fallback | No automatic resizing; an operator applies changes |
| Client/harness context and compaction settings | The client | Client-dependent; DSG does not rewrite them |

## What health checks actually establish

By default, DSG probes every five seconds. The backend must advertise the
configured model ID and an integer `context_length` at least as large as the
configured pool limit. A new registration must pass this check and is initially
paused. An existing worker becomes unhealthy after the configured failure
threshold (default: three failed probes), not necessarily on the first mismatch.
Recovery is detected on a successful probe.

This checks **reported metadata**, not usable RAM, long-context quality, vision,
cache correctness or throughput. Validate those on the model server separately.
Status may temporarily reflect old data between probes. Do not use the health
failure threshold as a substitute for draining a server before reconfiguration.

## Example: raising a mixed pool to 262,144

Suppose two servers currently support 153,600 tokens and a Mac supports 300,000.
The pool guarantee is 153,600. Raising one server to 262,144 changes its observed
worker metadata, but leaves the pool guarantee at 153,600. Even if every server
later supports 262,144 or more, the guarantee remains 153,600 until explicitly changed.

1. Back up the affected server's launcher/config and the gateway configuration.
2. Drain one worker through the UI or `./workers.sh drain SERVER_ID`.
   Drain stops new admission but lets already admitted requests finish. Verify
   active and queued counts are zero and check for direct backend requests too.
   Interrupt work only with the operator's explicit approval.
3. Change that server's approved settings, restart it, and validate actual
   context/cache/vision/thinking behavior. Preserve other settings and disk caches.
4. Inspect its observed `context_length` with `./workers.sh list` or the UI.
   Resume the worker after validation. Repeat for the other affected servers.
5. Once every enabled server intended to serve the pool has been verified at
   262,144 or higher, open **Manage DS4 servers → Pool context limit (tokens)**,
   enter `262144`, and choose **Apply pool limit**. DSG performs fresh model and
   capacity probes of every enabled server before saving. Unavailable or
   undersized enabled servers cause rejection; nothing is silently drained.
6. The explicit setting is backed up, durably saved, and applied immediately.
   **This operation requires no gateway or model restart and does not interrupt
   active streams.** Installing a new gateway software version may still require
   one restart; that is separate from subsequently using this control.
7. Verify gateway status, each eligible worker's observed context, and the
   client-facing `/v1/models`. The latter should advertise 262,144. Test a real
   request through DSG, including its returned worker identity and cache reuse.
8. Review client model metadata and compaction separately. Some clients pin
   context locally and do not discover it from `/v1/models`; do not assume a
   gateway change automatically updates an existing chat.

A Mac already supporting 300,000 does not need to be reduced to 262,144 for this
pool. Its extra capacity simply is not part of the pool-wide guarantee. If the
operator wants identical native limits, configure the Mac independently.

## Persistence and safety boundaries

Before the first UI setting, the top-level startup config `context_length` is
the pool default. The UI stores `pool_context_length` in the existing private
metadata store (alongside worker registration and affinity, not in browser
storage). A saved value takes precedence across restarts. Editing the startup
default does not override an explicit saved UI choice; use the UI to change it.

The existing atomic-replace/fsync mechanism persists the value before it becomes
active. Existing metadata is backed up to a uniquely named sibling `.context-…bak`
file before a change. Backups contain private metadata: do not publish them or
restore an old whole-state snapshot over newer session assignments. Reverting a
context choice through the UI preserves current worker/affinity state.

The control uses the same loopback-only, same-origin, CSRF-protected operator
channel as worker registration, with a private Unix socket behind it. There is
no context-mutation endpoint on the inference/LAN listener. A stale browser's
expected old value is rejected rather than overwriting a newer setting.

Paused workers do not constrain an explicit pool increase. An undersized paused
worker is made ineligible immediately and must pass a fresh compatibility probe
before **Enable** succeeds. No remote launcher, cache, output request, or Pi
setting is edited. Lowering the advertised limit requires UI confirmation,
because clients may change their compaction behavior; native allocations and
already dispatched request bodies are unchanged.

## What DSG does not do

- It does not calculate a moving minimum across currently online workers.
  Worker outages or additions therefore do not silently change advertised
  context, output allowances, or a client's compaction expectations.
- It does not count or truncate request tokens, reserve thinking tokens, rewrite
  `max_tokens`, or route oversized requests to a larger-context server.
- The advertised limit is not a gateway token-admission check. Generation
  bodies are forwarded unchanged; the selected DS4 backend enforces its native
  context and output rules. An oversized request can fail there.
- It does not certify settings just because `/v1/models` reports them.
- It does not move KV caches between devices. Session affinity helps reuse the
  chosen server's cache; that server controls hot/disk/cold behavior.

For this DS4 setup, **input, thinking and answer share the total context**.
262,144 is not 262,144 input plus another 262,144 output. A large default output
allowance remains bounded by remaining context and the client's request.

## Downgrades and adding smaller servers

A server below the configured pool minimum fails registration/compatibility.
Do not silently lower the pool to admit it. Keep it in a separately configured
pool, raise its native capacity after validation, or explicitly review a lower
pool guarantee and the effect on clients and ongoing conversations. Drain before
reducing a running worker's context: periodic detection has a finite delay.

The automated gateway tests cover worker-metadata refresh, a stable pool
guarantee during upgrades, live explicit pool changes and restart persistence,
uninterrupted streams, storage failure, stale edits, and rejection of workers
that no longer meet that guarantee. They are synthetic routing tests,
not GPU or long-context quality benchmarks.
