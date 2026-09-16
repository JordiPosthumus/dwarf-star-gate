# Recovery for a directly launched local oMLX server

This adapter uses an installation's existing `start.py`, `serve.sh` and
`server.pid`. It does not convert it to launchd, alter its settings, delete caches
or reinstall oMLX. It is for same-host macOS installations with that launcher
layout; endpoint registration alone does not enable it.

## Current validation

The disposable native macOS test proves that an active request prevents a test
restart, an idle process can be stopped gracefully and relaunched once, and
repeating the same action does not repeat the restart. Authenticated endpoints,
model aliases and the oMLX cache-proof format have verifier tests. These are
component tests, **not a completed recovery test on a real oMLX model server**.
Each installation still needs its own native generation/cache qualification.

## Private enrollment

Copy `ds4-gateway/recovery-omlx.py` and its sibling dependency
`recovery-launchd.py` into the private recovery directory. Keep both together.
Use a private configuration containing exactly:

```json
{
  "root": "/absolute/path/to/existing-omlx-installation",
  "binary": "/absolute/path/to/actual-running-python-executable",
  "port": 8013,
  "command_sha256": "<sha256 of the exact native process command>",
  "api_key_file": "/absolute/path/to/private-api-key",
  "start_stopped": true
}
```

The configuration and credential must be owner-only regular files. The helper
directory must be owned by the operator and not group/world writable. Derive the
command hash privately from the enrolled running process; its command may contain
credentials, so do not publish it. Inspect before making any service changes.

The gateway recovery worker uses `adapter: "omlx"`, `transport: "local"`,
`verification: "qwen_omlx"`, and the existing local `python`, `helper`, `config`,
`machine`, `profile`, `service_profile` and `start_stopped` enrollment fields.
Its URL must match the inference endpoint. The verifier uses that endpoint's
existing credential file, API base path and model alias. It does not need another
credential copy. Keep any other workers' enrollments and recovery switches intact.

The static profile covers the launcher, serving script, two settings files,
Python executable and exact command hash. It does **not** hash every installed
Python module or the model weights, or prove what source an existing process
loaded. Record those separately when establishing a deployment's provenance.

## Behavior

- A stopped service can be started only with explicit stopped-start enrollment,
  matching identity and an available port. The gateway's existing stopped-service
  policy, maintenance holds and recovery switch still apply.
- A running process can be restarted for an explicit recovery test only. There
  is no oMLX fatal-error classifier yet, so ordinary slow or hung responses do
  not become automatic restart authority.
- Before a test restart, authenticated `/api/status` must report zero active
  requests, waiting requests and loading models. Gateway admission must already
  be held. Direct clients must also respect that maintenance window.
- The adapter sends SIGTERM to the identified process and waits up to 30 seconds
  for its exit. It never escalates to SIGKILL. This is a process-exit observation
  deadline, not a chat cancellation limit. A pending stop stays an uncertain
  operation rather than being replayed.
- The existing `start.py` starts the server. Its acknowledgement is not proof of
  readiness. Readmission needs unchanged identity/context, real answers and
  two conversations with measured cold-to-warm cache reuse.
- The port check permits TCP TIME_WAIT left by closed connections, while a
  listening socket prevents startup. It is a sampled check, not a port lock.

Before the first live drill, retain the working launcher/settings and arrange
another serving LLM. Restore and verify the tested worker afterward. Existing
operator authorization can cover this drill; no repeated permission is needed.

Run the affected checks with `npm run recovery:test`. The native fixture starts
only its own temporary HTTP server and skips on non-macOS systems.
