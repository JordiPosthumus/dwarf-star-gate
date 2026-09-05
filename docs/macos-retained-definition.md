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

## What remains before automatic restoration

This diagnostic is not wired into Genie's action offers and does **not** implement
`launchctl bootstrap`. A matching pinned file alone says nothing about why the
service disappeared, whether the native GUI domain is usable, or who currently
owns its listener. The [native-removal audit](macos-removal-provenance.md) likewise
grants no action authority.

Restoration still needs separately approved bootstrap enrollment, trusted live
removal provenance tied to the prior process/boot, current native-disable and
DSG-maintenance vetoes, exact dependencies, safe command-time identity checks,
durable one-shot issuance, and an approved real removed-job canary proving
generation and cold-to-warm cache reuse before readmission. These capabilities
remain unfinished. Leave all existing operator reservations in place.
