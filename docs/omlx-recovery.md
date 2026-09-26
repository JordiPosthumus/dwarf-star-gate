# Recovery for a directly launched local oMLX server

This adapter uses an installation's existing launcher, `serve.sh` and
`server.pid`. The default launcher is `start.py`; an existing executable shell
launcher can instead be explicitly enrolled. It does not convert the installation
to launchd, alter its settings, delete caches or reinstall oMLX. It is for same-host
macOS installations with that layout; endpoint registration alone does not enable it.

## Current validation

The disposable native macOS test proves that an active request prevents a test
restart, an idle process can be stopped gracefully and relaunched once, and
repeating the same action does not repeat the restart. Authenticated endpoints,
model aliases and the oMLX cache-proof format have verifier tests. These are
component tests. A subsequent real Qwen/oMLX installation completed one
same-launcher restart, returned authenticated model metadata and real replies,
and was readmitted after two cold-to-warm conversations. Both cold requests had
zero cached tokens; each follow-up reused 4,096 tokens. The original profile,
source files and launcher/settings were preserved. Its matching local recovery
binding is connected in that installation.

This proves that installation's same-launcher restart and return, not rollback
to another environment or every failure case. The advertised context remained
262,144 tokens; this drill did not repeat a full context-boundary test. Each new
installation still needs its own native generation/cache qualification.

The controller-to-helper test also covers normalized OpenAI endpoint enrollment.
Its derived null journal-service field is excluded only when revalidating local
transport options; saved binding fingerprints and all action checks are retained.
That normalization fix has also passed a read-only inspection through the real
local oMLX helper; the real restart exercise above then verified the complete
controller-to-helper-to-model path.

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

For an existing executable launcher, add both `launcher` (its absolute path) and
`profile_files` (an explicit list of absolute dependency paths, up to 32). Include
guard scripts, sourced files and other startup dependencies whose changes must
invalidate enrollment. An empty list is permitted when there are no additional
dependencies. These files must be regular files owned by the operator or root,
without group/world write access; the launcher must be executable. Symlinks are
rejected. The adapter executes that exact path without a shell command string or
extra arguments, retaining the launcher's own shebang, environment setup and
guard behavior. It never substitutes `start.py`. Legacy enrollment profiles
remain unchanged when these optional fields are absent.

The gateway recovery worker uses `adapter: "omlx"`, `transport: "local"`,
`verification: "qwen_omlx"` for Qwen or `"glm53_omlx"` for GLM-5.3, and the existing local `python`, `helper`, `config`,
`machine`, `profile`, `service_profile` and `start_stopped` enrollment fields.
Its URL must match the inference endpoint. The verifier uses that endpoint's
existing credential file, API base path and model alias. It does not need another
credential copy. Keep any other workers' enrollments and recovery switches intact.

The static profile covers the launcher, serving script, two settings files,
Python executable and exact command hash. It does **not** hash every installed
Python module or the model weights, or prove what source an existing process
loaded. Record those separately when establishing a deployment's provenance.

GLM verification retains the enrolled thinking/template defaults and uses two
interleaved cold-to-warm conversations with fresh prefixes of at least 16,384
tokens. It requires zero cold cached tokens and warm reuse leaving no more than
8,192 original prefix tokens uncached. Its receipt is distinct from Spark/vLLM
and Qwen receipts. This does not exercise maximum context/output/concurrency or
certify any particular GLM installation until native verification succeeds.

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
- The existing enrolled launcher starts the server. Its acknowledgement is not proof of
  readiness. Readmission needs unchanged identity/context, real answers and
  two conversations with measured cold-to-warm cache reuse.
- The port check permits TCP TIME_WAIT left by closed connections, while a
  listening socket prevents startup. It is a sampled check, not a port lock.
- A helper interruption after durable intent is not automatically replayed. A
  saved intent alone cannot prove whether stop or launch happened. Supported
  reconciliation across that boundary remains necessary for full independence.

Before the first live drill, retain the working launcher/settings and arrange
another serving LLM. Restore and verify the tested worker afterward. Existing
operator authorization can cover this drill; no repeated permission is needed.

Run the affected checks with `npm run recovery:test`. The native fixture starts
only its own temporary HTTP server and skips on non-macOS systems.
