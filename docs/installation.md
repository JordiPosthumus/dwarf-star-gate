# Installation and private runtime

DSG runs directly from one checkout. No copy into a deployment directory is
needed. The directory can be named `DSG` or anything else; no operator-specific
path is compiled into the source.

```text
DSG/
  ds4-gateway/           versioned gateway, dashboard, encoder and recovery code
  scripts/              versioned setup/check commands
  predictor/            versioned optional offline training code
  examples/             public, generic example configuration
  config.local.json     PRIVATE, ignored: key, endpoints and local policy
  runtime/              PRIVATE, ignored: affinity, logs, reports, training data
```

DS4 itself, model weights, and engine KV caches belong to the model-server
installation, not this gateway. SSH credentials stay in the operator's normal SSH
configuration. DSG does not copy them into the project.

## First run

Follow the [README quick start](../README.md). Node 22.22.2+ is required; the core
has no package dependencies. `npm run setup -- --controls` creates an empty fleet
with local UI management enabled. Without that explicit flag the UI is read-only.
Setup uses a random inference key and exclusive mode-0600 file creation: an
existing config is an error, not permission to regenerate it. No servers start.

`npm run doctor` checks local config, ports, paths, worker/recovery definitions,
existing durable registry and optional encoder files. If a durable worker endpoint
or recovery route differs from a worker declared in private config, it reports the
count without exposing route names. The durable registry remains authoritative and
must be reconciled explicitly with the worker controls. Doctor does not contact workers,
perform inference, create runtime state or repair anything. Passing doctor is not
a claim that DS4 is ready: registration and gateway health probes check the actual
model/context; inference and cache behavior require separate validation.

Start all three foreground processes (`gateway.mjs`, `door.mjs`, and
`dashboard.mjs`) when the Continuity Door is enabled, then use **Manage DS4
servers** to add a worker. `./start-dsg.sh` is the recommended macOS path.
A same-host DS4 endpoint needs a loopback URL. A remote worker needs an SSH alias,
an unused local tunnel port and the remote model-server port. First establish SSH
trust/authentication yourself. Registration probes compatibility and leaves the
worker paused until explicitly enabled. The UI never edits its model settings.
Match the configured pool model/context to the intended fleet before enabling it.

The `api_key` in DSG's configuration authenticates clients to the gateway only.
Registered workers are stock, unauthenticated DS4 endpoints protected by
loopback or DSG's host-key-verified SSH tunnel. DSG deliberately strips its
ingress bearer credential before every worker inference request; model-list and
health probes are unauthenticated as well. Per-worker API credentials and generic
authenticated OpenAI backends are not part of this DS4-specific worker contract.

## One config contract

1. An explicit config argument, on commands that support one.
2. `DWARF_GATE_CONFIG` (use an absolute path for unattended operation).
3. `config.local.json` at this checkout's root, independent of the caller's cwd.

An explicit relative config filename is resolved against the caller's cwd.
Inside the JSON, relative **local** paths are resolved against the config file's
directory: state, control socket, telemetry files, optional cache directories and
encoder executable/model.
Remote recovery helper paths are deliberately not rewritten. Set `ui_port` to
change the dashboard port; `GATEWAY_UI_PORT` overrides it consistently in both
foreground and convenience commands. macOS installation records the effective
port and absolute checkout/config paths, but never embeds the inference key in
the service manifest.

When migrating an older config that relied on cwd-relative paths, review those
paths first or make them absolute. There is no silent fallback to a separate
`config.production.json`; select legacy filenames explicitly if retaining them.

An optional local, read-only cache inventory uses:

```json
"cache_directories": { "studio": "/srv/ds4/cache" }
```

The worker must already be registered and the directory must be readable on the
dashboard host. This can be a same-host DS4 directory or an operator-mounted
read-only filesystem; DSG does not mount it. A private 32-byte HMAC key is created
under the ignored mode-0700 dashboard runtime only when this feature is configured.
Changing or losing that key invalidates cross-scan pseudonyms but never changes a
DS4 cache. Remote SSH inventory is not silently inferred from a worker's management
route and remains future explicitly enrolled work.

## macOS login services

For normal use, prefer the [start/stop scripts](#start-and-stop-scripts-macos)
below. The lower-level controls remain available. Stop foreground copies first.
`npm run service -- install` writes three user
LaunchAgents and backs up previous DSG registrations. It refuses to replace a
loaded service and does not start anything. Then use:

```sh
npm run service -- start
npm run service -- status
npm run service -- restart dashboard
npm run service -- stop
```

Names are `local.dwarf-star-gate.gateway`,
`local.dwarf-star-gate.continuity-door`, and
`local.dwarf-star-gate.dashboard`. One installation per macOS user is supported.
These run at **login**, not before login as system LaunchDaemons. A logged-out
user cannot rely on these agents to serve the fleet. Linux currently uses the
foreground commands under the operator's own supervisor; DSG does not claim to
install a Linux service.

Gateway stop/restart refuses busy or unknown state by default. With the Continuity
Door enabled, a normal gateway restart holds new unread calls at the stable door,
drains the old core, verifies the replacement startup barrier, and releases only
after a fresh health check. See the [exact boundary](continuity-door.md).
`--interrupt` is explicit permission to abandon active/queued requests and bypass
that safety. This is not arbitrary mid-stream engine recovery. The commands never
stop DS4 or alter worker policy,
context, sampling, cache or concurrency settings. Durable affinity and worker
pause/quarantine state survive. In-flight requests do not survive a forced stop.

Dashboard stop/restart saves a private Genie report snapshot under
`runtime/dashboard/backups/`. A single `restart` restores enabled/source settings;
old in-memory reports remain in the archive, not re-imported into the live panel.
A separate stop/start uses the configured default: on unless
`genie.enabled` is explicitly `false`. An interrupted health review is not
resumed. Optional automatic recovery policy is separate and remains in durable
gateway state.

Service commands refuse a registration pointing to another checkout/config/port.
Restart keeps the registered Node interpreter even if your shell uses a newer
Node; changing it requires an explicit stopped-service reinstall.
To move this project: stop the old services, back up config and quiescent runtime,
move the checkout and runtime, update only affected local paths, reinstall service
registrations, then start and validate. Python virtual environments are not
relocatable: recreate them from the locked projects rather than trusting moved
console-script shebangs. Encoder model files and collected data can be preserved.
Archive any older custom service registration so it cannot respawn a second
gateway. Do not start two writers against the same affinity file.

## Start and stop scripts (macOS)

Run from the checkout, or invoke any script by its full path from any directory:

```sh
./start-dsg.sh --open
./park-dsg.sh
./stop-dsg.sh
```

Run as the normal logged-in operator, **not sudo**. Node 22.22.2+ must be on PATH.
These are macOS login-service helpers, not Linux service installers. On Linux,
continue to use the foreground commands under your chosen supervisor.

`start-dsg.sh` automatically:

1. Validates the platform, Node version, source syntax and existing private config
   with the read-only doctor. It does not run inference or install dependencies.
2. Checks missing registrations for an existing listener or loaded service; it
   refuses to take over an unidentified process.
3. Copies the private config and existing atomic affinity file into a unique,
   mode-0700 `backups/lifecycle-…` directory beside the state file. Files are
   mode 0600, with a manifest identifying their source paths and source revision.
4. Installs **only absent** gateway/Continuity Door/dashboard LaunchAgents. Existing registration
   paths, ports and Node interpreters are preserved; mismatches fail closed.
5. Starts stopped DSG services and checks the authenticated core, Continuity Door
   and dashboard status responses. Already-running services are not restarted.
6. Reports endpoints, pool context, activity/queues and excluded workers, and
   optionally opens the dashboard. Zero available workers or a retained global
   admission drain produces a prominent warning, not a false inference-ready claim.

Starting DSG also starts its **already-configured** SSH tunnels and optional
collector/encoder/predictor components through the ordinary gateway. The script
does not provision SSH trust, install Python environments, download models, start
remote DS4 services, clear quarantines, release maintenance locks or agent holds, resume workers or
alter model/context/output/thinking/cache/concurrency settings. Missing setup is
reported; it is never replaced with a guessed fallback.

`park-dsg.sh` is the continuity-preserving way to leave the gateway core stopped
temporarily. It atomically asks the stable Continuity Door to hold new request
bodies unread, waits for active and already-queued core work to finish, fences
admission, stops only the core, and verifies that the core port closed while the
Door still listens. The dashboard and every DS4 server remain running. It refuses
to overwrite a different manual Door hold.

Run ordinary `./start-dsg.sh` to resume. Start launches the stopped core, waits
for its startup barrier, checks the exact park marker, and only then releases held
calls. A failed start leaves the Door holding. Park is an in-memory continuity
operation for the current login session: stopping/restarting the Door, logging
out, or rebooting cannot preserve its live client sockets.

`stop-dsg.sh` backs up the same control files, then uses the existing controller's
ownership checks, busy/unknown refusal and final admission fence. It stops the
dashboard, Continuity Door and gateway core in that order and verifies every
launchd removal and port closure.
An unexpected surviving listener is an error; it is never killed by guessing its
PID. Repeating stop on an already-stopped installation is safe. Stop does **not**
run syntax or optional encoder/predictor dependency checks, so those failures do
not prevent an otherwise valid managed shutdown.

The existing dashboard controller separately archives Genie reports before
stopping. After a separate stop/start, a configured Genie starts **on** unless
private config explicitly sets `genie.enabled` to `false`. Turning him off in the
UI pauses observation until the next dashboard start. Durable recovery
authorization remains a separate switch; worker pause/hold/quarantine state is retained.
Services stay installed for the next login; stopping does not uninstall them.

Useful options:

```sh
./park-dsg.sh --json
./start-dsg.sh --only dashboard --open
./stop-dsg.sh --only dashboard
./start-dsg.sh --config /path/to/private-config.json --json
./stop-dsg.sh --help
# ONLY when willing to abandon active/queued client requests:
./stop-dsg.sh --interrupt --confirm-interrupt
```

Without both interruption flags, busy work is not cancelled. With both flags,
clients may fail and need a retry; queued HTTP connections and partial streams
are not persisted. DS4 processes stay running and may still be handling other
direct clients. A dashboard-only stop interrupts Genie reviews, not model requests.

`--config` takes precedence over `DWARF_GATE_CONFIG`; relative filenames belong to
the caller's directory. Otherwise the default is this checkout's
`config.local.json`. `--json` keeps the result on stdout and progress on stderr.
Exit 0 verifies the requested **service** action, not a generation/cache test;
inspect `fleet` and `warnings` before sending inference. Failure exits nonzero
and never triggers an automatic rollback, model restart or settings change.
If gateway start succeeds but dashboard start fails, the gateway is left running
and the failure is reported. Resolve it and rerun start; do not blindly restart.

The automatic backup is deliberately small: config and one atomic affinity-file
snapshot, **not** a consistent backup of all logs, reports, embeddings or training
data. Backups remain private and are not pruned automatically. For disaster
recovery, safely stop writers and separately back up the complete runtime.
Restoring config/state is an explicit stopped-service operation, never automatic.

Tests cover option parsing, first/partial/repeated startup, busy refusal,
interruption scope, ownership conflicts, listener verification, degraded status,
private backup permissions and shell invocation from another directory. The
orchestration tests inject the service controller; existing controller tests cover
fencing/launchd removal. These do not constitute a remote DS4 performance test.

## Logs, upgrades and privacy

Login services write gateway logs beside the state file and UI logs beneath
`runtime/dashboard/`. `start-gateway.sh` also records foreground gateway output;
`npm start` writes to its terminal. `gateway-logs.sh` follows the selected log.
Live diagnostics and training artifacts are private even without raw text.

Before updating: inspect `git status`, back up private config/runtime and record
the current commit. Pull/review the update, run checks, then restart only DSG.
Do not overwrite private config with an example. A Git clone/push backs up source,
**not** private runtime: back that up separately while writers are stopped for a
consistent snapshot. Preserve previous data/config when rolling back; a source
rollback alone is not a runtime-schema rollback.

Install the staged-content privacy hook with `npm run hooks:install` and read
[publication policy](publication-policy.md). `.gitignore` prevents ordinary adds,
not forced adds or disclosure of already tracked files. Hooks and CI add checks,
not a guarantee; review the staged diff. Never publish `config.local.json`, real
inventory, credentials, runtime, embeddings, candidate models or local backups.

The clean-checkout test in `ds4-gateway/install.test.mjs` starts actual DSG
processes from an unrelated cwd, registers a synthetic DS4 endpoint through the
UI API, checks byte-exact forwarding and durable restart state, and verifies that
private artifacts remain untracked. It neither uses real models nor proves their
performance. Normal unit/streaming/recovery tests remain separate.
