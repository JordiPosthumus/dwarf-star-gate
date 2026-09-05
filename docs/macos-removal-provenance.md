# Mac job-removal provenance: read-only audit

A missing LaunchAgent is not evidence of an engine crash or an accidental stop.
Before designing automatic restoration, establish which exact native record
describes the former service instance. DSG provides an offline diagnostic:

```sh
node ds4-gateway/launchd-removal-audit.mjs \
  --log /private/path/native-removal.ndjson \
  --identity /private/path/removal-identity.json
```

The identity file is private JSON with exactly these fields:

- `uid`: the service owner's numeric user ID.
- `label`: the enrolled LaunchAgent label.
- `pid`: the independently observed former DS4 process ID.
- `boot_uuid`: the independently verified native boot-session UUID.
- `since` and `until`: explicit offset-bearing timestamps, at most four hours
  apart. Use the actual incident window, not an assumed process lifetime.

Use a complete native `log show --style ndjson` capture with its final
`{"count":...,"finished":1}` record. The capture must fit the two-MiB / 10,000-event
audit bounds. Narrow an oversized capture deliberately; do not silently truncate
it and call the remaining evidence complete. File and identity inputs must be
regular, non-symlink files; filesystem/JSON errors do not echo private content.

## Why a message-only search can miss the cause

The observed launchd format puts the job identity in **subsystem**, for example
`gui/501/com.example.ds4 [1234]`, while the message says only
`removing job: caller = loginwindow`. Searching the message for the service label
can find “removing service” summaries while missing the actual caller record.

The exported `removalPredicate(identity)` builds an exact-subsystem predicate from
validated private fields for native capture tools; it is not a shell command.
The auditor additionally verifies native process ID 1, both launchd image paths,
boot UUID and the time window. Matching a label substring, another PID, a prior
boot or a message quoting the native wording is insufficient.

## What the result does—and does not—prove

- `exact_removal_observed`: a complete supplied capture contains a matching record.
  The bounded caller is `loginwindow`, `launchctl`, `runningboardd` or `other`.
- `conflicting_callers`: more than one caller class matched; all bounded
  observations remain visible. Never select the most convenient cause.
- `no_exact_removal_record`: no qualifying record was found, **not** proof that
  no removal occurred.
- `source_incomplete`: malformed/truncated capture, missing/count-mismatched
  footer or invalid event shape. No positive observations are returned.

“Complete” describes the supplied capture's structure, not a guarantee that macOS
retained every event. Timestamps are normalized to milliseconds; at most 16
deduplicated observations are returned, with an omitted count. No raw messages,
labels, PIDs, boot IDs, addresses or file paths appear in the result.

Every result has `authority: "none"`. An archive can be copied or forged, and the
caller name does not explain intent: even loginwindow may be acting on an
intentional user action. This CLI does not query live services, change routing,
write an enrollment, invoke launchctl, or feed a recovery offer to Genie.

## Direct native capture through the enrolled helper

The updated Mac helper now supports fixed `inspect_removal` diagnostics. This
does **not** accept an archive, path, predicate, label or shell command from Genie.
The gateway supplies only its previously retained private service identity; the
helper independently checks its machine, boot, static profile and current job
absence, then queries `/usr/bin/log` itself. It rechecks boot, profile and absence
after capture. A job appearing during the query suppresses positive evidence.

The query uses the exact configured label, retained PID and current owner UID,
explicit UTC times, a maximum four-hour lookback, a thirty-second diagnostic
allowance and a two-MiB combined pipe bound. It checks the native sender, boot,
event timestamps and count-checked complete footer. Output contains only bounded
status, counts, timestamps and caller classes; raw records are never sent back
to the gateway. Stream errors, limits, malformed records and changed identity
remain unknown evidence. These bounds do not alter inference/provider deadlines.

On an enrolled Mac, normal inspections now retain the observed native boot UUID
in a private companion record bound to the complete service-identity digest.
The original identity-record format stays unchanged for older controllers.
Legacy records without boot evidence, mismatched companions and changed enrollment
cannot seed native queries. A transient unreadable boot does not erase an earlier
historical observation or imply that it is fresh.

For a confirmed absent job with matching retained evidence and a capable helper,
the recovery controller runs this diagnostic at most once per five minutes for
the same identity. Changed identity/state invalidates it; a late result cannot
replace newer live-service evidence. Capture failures do not create recovery
operations or change worker health. The bounded result is exposed as `removal`
in recovery worker status and included in Genie's evidence with `authority:none`.
Genie must report its `checked_at` time, distinguish caller from intent, and respect
all operator reservations. No bootstrap offer is created by this result.

This is a direct query by an explicitly enrolled helper, not cryptographic OS
attestation. The caller still does not prove an accidental stop; the native record
identifies a PID/boot, not a full proof against every possible PID-reuse history.
`no_exact_removal_record` still does not prove that nothing happened, and capture
completeness still does not guarantee full OS retention. Do not reinterpret these
diagnostics as automatic start permission.

Before automated bootstrap, DSG still needs separately approved restore policy,
a [verified retained definition](macos-retained-definition.md), command-time
GUI/native-disable/DSG-hold and listener checks, durable one-shot execution, and an
approved real removed-job cold/warm canary. Those capabilities remain separate
work. Updating the source checkout does not deploy a helper or enroll a real Mac.
See [worker recovery](worker-recovery.md).
