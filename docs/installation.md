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
existing durable registry and optional encoder files. It does not contact workers,
perform inference, create runtime state or repair anything. Passing doctor is not
a claim that DS4 is ready: registration and gateway health probes check the actual
model/context; inference and cache behavior require separate validation.

Start both foreground processes, then use **Manage DS4 servers** to add a worker.
A same-host DS4 endpoint needs a loopback URL. A remote worker needs an SSH alias,
an unused local tunnel port and the remote model-server port. First establish SSH
trust/authentication yourself. Registration probes compatibility and leaves the
worker paused until explicitly enabled. The UI never edits its model settings.
Match the configured pool model/context to the intended fleet before enabling it.

## One config contract

1. An explicit config argument, on commands that support one.
2. `DWARF_GATE_CONFIG` (use an absolute path for unattended operation).
3. `config.local.json` at this checkout's root, independent of the caller's cwd.

An explicit relative config filename is resolved against the caller's cwd.
Inside the JSON, relative **local** paths are resolved against the config file's
directory: state, control socket, telemetry files and encoder executable/model.
Remote recovery helper paths are deliberately not rewritten. Set `ui_port` to
change the dashboard port; `GATEWAY_UI_PORT` overrides it consistently in both
foreground and convenience commands. macOS installation records the effective
port and absolute checkout/config paths, but never embeds the inference key in
the service manifest.

When migrating an older config that relied on cwd-relative paths, review those
paths first or make them absolute. There is no silent fallback to a separate
`config.production.json`; select legacy filenames explicitly if retaining them.

## macOS login services

Stop foreground copies first. `npm run service -- install` writes two user
LaunchAgents and backs up previous DSG registrations. It refuses to replace a
loaded service and does not start anything. Then use:

```sh
npm run service -- start
npm run service -- status
npm run service -- restart dashboard
npm run service -- stop
```

Names are `local.dwarf-star-gate.gateway` and
`local.dwarf-star-gate.dashboard`. One installation per macOS user is supported.
These run at **login**, not before login as system LaunchDaemons. A logged-out
user cannot rely on these agents to serve the fleet. Linux currently uses the
foreground commands under the operator's own supervisor; DSG does not claim to
install a Linux service.

Gateway stop/restart refuses busy or unknown state by default. A final admission
fence prevents a new request racing an idle check. `--interrupt` is an explicit
permission to abandon active/queued requests; clients may need to retry. This is
not seamless stream recovery. The commands never stop DS4 or alter worker policy,
context, sampling, cache or concurrency settings. Durable affinity and worker
pause/quarantine state survive. In-flight requests do not survive a forced stop.

Dashboard stop/restart saves a private Genie report snapshot under
`runtime/dashboard/backups/`. A single `restart` restores enabled/source settings;
old in-memory reports remain in the archive, not re-imported into the live panel.
A separate stop/start starts Genie off, as on ordinary dashboard startup. An
interrupted health review is not resumed. Optional automatic recovery policy is
separate and remains in durable gateway state.

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
