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

Before automated bootstrap, native capture needs a trusted live path joined to
the controller's retained instance evidence, a verified retained service
definition, current GUI/native-disable/DSG-hold checks, durable one-shot execution,
and an approved real removed-job cold/warm canary. Those capabilities are still
separate work. See [worker recovery](worker-recovery.md).
