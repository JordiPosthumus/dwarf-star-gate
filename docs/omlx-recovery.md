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

### Durable Genie restart qualification

For a previously enrolled local GLM/oMLX worker, separately set
`omlx_recovery_setup.workers[worker_id].qualify_restart` to `true`. Automatic
recovery, server changes and inspection must also be enabled. Genie reads current
`recovery_status.workers[].omlx_qualification` and calls `qualify_omlx_recovery`
with that worker's eligible evidence ID. The tool does not accept commands,
paths, settings or replacement launchers, and does not grant stopped-start
permission. Ordinary operator canaries retain their existing pause semantics.

The core requires a healthy unpaused worker, idle physical aliases, current
native identity and another available physical LLM. It backs up metadata before
saving intent and reserving every alias on the worker's machine. Existing active
or waiting work prevents admission. Requests arriving after that reservation
remain waiting; only queues held by this exact operation can be discounted during
its subsequent ownership checks and readmission. Active slots, native reservations,
foreign recovery operations and owner holds still block changes.

`recovery_omlx_transaction.py`, adjacent to the enrolled adapter, retains a private
request, exact process/profile identity, original launcher/settings backups, and
a journal around each stop and launch. Its detached runner survives its caller.
A new runner can continue after an observed stop or observe a replacement already
launched without issuing either command twice. Each mutation requires a current
permit from the gateway's owner-only `/recovery-omlx-permit` socket route. These
routes are not exposed on the inference HTTP listener. Native active work prevents
the stop; the replacement listener must also report zero active/waiting requests
and loading models before the transaction completes.

The adapter also supports `transaction-status` with only an `action_id`. This
reads the existing private request, journal and verified backup without obtaining
a mutation permit, spawning a runner or creating missing files. Its request hash
lets a controller join the receipt to its saved intent. It is available when
mutation permission has been withdrawn. A missing record or pending receipt does
not establish process liveness, service health, or permission to repeat an action.

The staged `start-transaction` protocol is distinct from a restart. It requires
the private adapter's explicit `start_stopped: true`, a recorded stopped epoch,
an exact static profile, an empty listener and a gateway permit bound to a demand
UUID. It never sends a stop signal. The same durable intent and backup rules
protect its one launch; an interrupted launch is observed, never repeated. A
lost or revoked permit before launch leaves it waiting; a change at the final
launch guard preserves an uncertain receipt. The native fixture tests exercise
this protocol and read-only observation after permission revocation.

**On-demand integration is not complete:** the production controller does not yet
issue this demand-bound start protocol or enroll its authority through Genie.
Do not enable a deployment's stopped-start setting merely because the adapter
protocol passes its tests. Completion still needs live-demand admission,
cancellation handling, controller reconstruction, and native correctness/cache
proof before queued inference is released. Existing restart qualification and
legacy manual start behavior remain separate.

Readmission additionally requires unchanged process/profile, native model context
and two actual cold-to-warm GLM/oMLX conversations. A Spark/vLLM or Qwen receipt
cannot qualify this worker. A late owner pause remains effective. A late hold or
policy revocation retains the same operation and reservation. Controller restart
restores ownership and continues observation and verification under the same ID.
The completion watcher returns to the original Genie conversation to observe the
terminal tool receipt; it does not issue another restart.

Disposable macOS tests exercise the connected adapter entry point, controller
exit, abrupt runner exit after SIGTERM, and native-busy waiting followed by the
same action's continuation. They verify one stop, one replacement launch and an
unchanged fixture profile. Controller tests cover a real HTTP request waiting
until private-socket qualification finishes, wrong proofs, identity changes,
owner decisions and reconstruction. Installed-Hermes tests verify the tool and
persisted handle. These fixtures do not certify any real GLM installation.

A crash between saving intent and issuing a command remains ambiguous. The runner
observes and does not repeat that command. A saved intent alone is never proof
that the command ran. Native qualification of the intended model and cache must
still be completed before claiming that installation is restart-qualified.

## Private enrollment

For Genie-controlled GLM/oMLX enrollment, configure the worker normally and add
an `omlx-local` inspection target with its existing root, URL and private API-key
file. Its URL must exactly match the registered endpoint. Add an explicit setup
policy for that worker, using your own paths:

```json
{
  "omlx_recovery_setup": {
    "workers": {
      "my-local-glm": {
        "exclusive": true,
        "launcher": "/absolute/path/to/existing/start.sh",
        "profile_files": ["/absolute/path/to/existing/guard.sh"]
      }
    }
  }
}
```

The worker needs an explicit model alias for the gateway model and a single
physical-machine mapping. With inspection, server changes and automatic recovery
enabled, Genie can call `enroll_omlx_recovery(worker_id)`. It supplies no command,
path, configuration or fingerprint. The core saves an action ID and metadata
backup, captures the native process/listener and model context repeatedly, checks
the configured concurrency, and retains the exact launcher/settings profile in
owner-only evidence. Ownership, policy and bindings are checked again before
committing authority. Existing recovery bindings are preserved and collisions
are refused. Inspection and inference may use separate existing credential files;
neither is copied into public receipts or rewritten.

`recovery_status.omlx_enrollment.operations` reports the durable result. Pending
read-only capture resumes under the same ID after core replacement. A completion
watcher returns to the originating conversation if Genie finishes before the
receipt arrives, respecting stopped replies and paused queues. Enrollment is not
restart qualification: this workflow does not pause routing, stop/start a process
or grant stopped-start authority. Restart qualification is a separate explicit opt-in, described above; enrollment
alone does not establish a working restart or cache receipt.

For manual enrollment of an existing supported installation:

Copy `ds4-gateway/recovery-omlx.py` and its sibling dependency
`recovery-launchd.py` into the private recovery directory. Keep both together.
For durable Genie qualification, also retain the sibling
`recovery_omlx_transaction.py`; do not copy only the original two-file adapter.
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
- A helper interruption after durable intent is not automatically replayed. The
  durable Genie transaction can continue after an observed stop and can observe
  an already launched replacement. The legacy manual adapter retains its original
  intent-only behavior. Ambiguous pre-command intent in either path remains
  observation-only; it does not authorize another signal or launch.

Before the first live drill, retain the working launcher/settings and arrange
another serving LLM. Restore and verify the tested worker afterward. Existing
operator authorization can cover this drill; no repeated permission is needed.

Run the affected checks with `npm run recovery:test`. The native fixture starts
only its own temporary HTTP server and skips on non-macOS systems.
