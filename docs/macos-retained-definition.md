# Retaining a Mac DS4 launch definition — agent preflight

**For the owner's local setup agent.** This is preparation for restoring an
OS-removed LaunchAgent, not permission to start it. Normal loaded-job recovery
does not require this optional preflight. See the [enrollment guide](worker-recovery.md#enrollment-start-here)
for existing recovery authority and per-installation canaries.

## Preserve, do not reconstruct

1. Inspect the exact DS4 LaunchAgent and its normal launcher. Establish which
   plist bytes were actually submitted, and which scripts/environment files
   determine the launch. Back them up before proposing any change.
2. With the owner's approval, retain an **exact private copy** of that plist at a
   canonical absolute path, in an owner-controlled directory. Use mode `0600`
   for the file and `0700` for its directory. Do not place it in a login-item
   directory, register it, alter arguments, or rewrite it through a plist serializer.
3. If the launcher deleted its transient plist, do not rebuild it from `ps`, an
   error message or an old example. Arrange an approved opportunity to preserve
   the original bytes from the normal launcher. A successful hash check cannot
   establish that a guessed definition matches the running service.
4. Independently compare the retained definition with the actual normal launch:
   executable/runner, arguments, environment, working directory, context/output,
   thinking, concurrency, caches, logging and launchd lifecycle settings. Retain
   dependencies in `profile_files`; do not substitute diagnostic defaults.

## Pin and inspect the private artifact

In the private **Mac helper config**, `plist` may name that retained copy. Add the
optional `retained_definition_sha256` containing its independently reviewed,
lowercase SHA-256 digest. This is a content pin, not a machine identity or a grant
of bootstrap authority. Never automatically recompute the pin to silence drift.

Changing `plist` changes the adapter's static service identity (the path is part
of the fingerprint). Existing enrollment cannot simply keep its old fingerprints:
review and revalidate that change through the normal enrollment workflow. Adding
only the pin does not change existing start/restart behavior or launch settings.

Send this exact read-only request to the fixed helper:

```sh
printf '%s\n' '{"action":"inspect_definition"}' | \
  python3 /absolute/path/to/recovery-launchd.py /private/path/to/helper-config.json
```

The preflight does not call launchctl, inspect processes, write files, acquire an
action journal or touch routing. No path, label or shell command is accepted in
the request. It returns `authority: "none"` in every diagnostic result.

- `enrolled:false`: no content pin was supplied.
- `verified:true`, `scope:"pinned_definition_only"`: a stable bounded private
  regular file matches the reviewed bytes and passes the minimal plist checks.
- `verified:false`: inspect `reason`; missing/nonprivate files, content drift,
  concurrent modification, malformed/duplicate keys, wrong label and a retained
  `Disabled:true` setting remain explicit failures. **Check `verified`, not just
  the process exit code.** Configuration/protocol failures may instead exit nonzero.

XML and binary plists are supported. The one-MiB artifact bound is not a model,
context, output or cache limit. The verifier checks exact label and basic
Program/ProgramArguments shape with an absolute executable; empty subsequent
arguments are preserved. It does not whitelist/rewrite the rest of the definition
or claim to validate every launchd key. Environment and all other bytes stay intact.
Output contains no arguments, environment values, file paths or content hashes.

## Separate removed-job helper action — not yet automatic recovery

The helper now implements a separately opted-in `bootstrap` action. The
`inspect_definition` diagnostic remains read-only and grants no authority.
**The gateway does not yet offer or invoke bootstrap:** controller integration,
maintenance coordination, a removed-job canary and automatic-use certification
remain unfinished. Do not enable this as an unattended recovery workaround.

Only after reviewing the exact additional authority, the owner's setup agent can
add these private helper settings for a controlled integration/canary exercise:

```json
{
  "bootstrap_removed": true,
  "bootstrap_callers": []
}
```

The existing reviewed `retained_definition_sha256` is also mandatory. Absence or
false leaves this capability off. `bootstrap_callers` may contain only explicitly
approved `loginwindow` and/or `runningboardd`, without duplicates. An empty list
allows no ordinary OS-caller restoration. `launchctl` and unknown callers cannot
be enrolled for ordinary restoration. A separately authorized operator canary may
use `canary:true` with an exact `launchctl` removal observation; that flag is
privileged executor input, **not** a field for Genie to choose. The helper transport
is an owner-trusted execution boundary, not a public unauthenticated API.

The fixed action schema is `action:"bootstrap"`, a fresh UUID-v4 `action_id`, the
exact retained `prior` identity used by `inspect_removal`, the reviewed
`definition_sha256`, and boolean `canary`. It accepts no paths, labels, shell
commands or launch settings. The helper independently:

1. Queries native evidence for that exact prior PID/boot and requires one complete
   unambiguous removal observation within its bounded capture window. A caller
   identifies the actor, not whether the removal was accidental. Owner-selected
   caller policy supplies authorization; the log cannot supply it.
2. Checks the machine, boot, static dependencies, absent job in a usable GUI
   domain, native disable override and unoccupied port. Unknown evidence vetoes.
3. Stages the **exact bytes** in a private fixed-name sibling plist using exclusive
   creation and mode `0400`, and durably saves an intent under the action lock.
4. Rechecks original/staged bytes and native identity, disable and port conditions
   after intent, then issues only `launchctl bootstrap gui/<helper-uid> <staged-file>`.
   No `enable`, extra kickstart, launcher reconstruction or settings rewrite occurs.

Standalone definitions must have `RunAtLoad:true` or unconditional `KeepAlive:true`.
Bundle-relative `BundleProgram` and chroot-style `RootDirectory` definitions require
separate review and are not supported by this action. Rejection never modifies them.

The receipt records `intent` or `issued`, **not recovered**. Repeating an action ID
returns its existing receipt; changing its body conflicts. A new ID cannot repeat
bootstrap for an already-attempted removed instance. Timeout, uncertain command
acknowledgement, or failed final receipt write require inspection/reconciliation,
not a second command. Staged files are retained because launchd may retain their
paths. A staging/journal failure may also leave a private artifact; never overwrite
it or delete a loaded definition merely to retry. Journal capacity remains bounded.

These are sampled checks, not an atomic lock over independent maintenance agents.
The helper cannot see DSG operator holds itself: the trusted caller must coordinate
maintenance and ensure there is no admitted work before invoking it. The pending
controller integration must enforce those conditions and refuse automatic use
until that installation passes a real removed-job canary with generation and
cold-to-warm reuse. Keep existing reservations and quarantine until verification;
a bootstrap command succeeding alone proves neither DS4 health nor safe readmission.
