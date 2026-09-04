# Request-to-engine attribution

**Implemented as shadow evidence; never a routing input or exact identity claim.**
DSG now separates two questions that were previously conflated:

1. Did the DS4 backend process change?
2. Which gateway request, if any, plausibly caused one observed engine prompt?

## Backend process epochs

For systemd journal telemetry, DSG requests the stock
`_SYSTEMD_INVOCATION_ID`, `_BOOT_ID` and `_PID` fields. It prefers the invocation
ID and labels boot ID plus PID as a weaker fallback. The UI, metrics, diagnostics
and Gate Genie receive only a domain-separated SHA-256 digest bound to the worker
ID; raw OS identifiers are never retained.

A journal reconnect with the same service invocation keeps the same epoch. For a
local stock-DS4 log, DSG can derive a weaker bounded epoch from the most recent
timestamped `listening on` marker, file identity and byte location. It scans at
most the latest 8 MiB on reader startup; an older/missing marker stays unknown.
Only the derived digest is retained—the endpoint and raw line are not. A new
epoch clears incomplete timing spans, speed history, cache counters and component
cost samples in the dashboard observer. It does **not** restart DS4, remove cache
files, change model settings, change routing or touch Pi. Missing process evidence
remains unknown.

## Conservative request candidates

The dashboard joins its bounded gateway lifecycle tail to DS4 `prompt start`
events in the same worker and observed process epoch. A row is:

- `candidate` when exactly one gateway dispatch window can explain the start;
- `corroborated` when that one candidate later reports exactly matching prompt
  and cached-token usage, or when every clock-overlapped gateway window has
  completed and exactly one reports that matching usage tuple;
- `abstained` when the epoch is missing, no window exists, windows overlap, one
  request sees multiple starts, returned usage conflicts, or more than one
  overlapped request reports the same tuple.

With a strong systemd epoch, `corroborated` means **high-confidence candidate**,
not protocol proof. The boot/PID fallback and local-log listen-marker epoch remain
explicitly bounded. DS4 does not currently echo the gateway request ID into its
timing record. Invisible direct clients and unknown clock error cannot be ruled
out merely by a time-and-usage match. Therefore these rows do not train XGB,
accuse a route of a cache miss, move work, or authorize recovery.

The correlator retains 15 minutes of completed history, but preserves an open
attribution span for up to seven days so long-context xhigh generations are not
discarded merely for being slow. It uses a five-second clock tolerance and a
ten-minute maximum dispatch-to-prompt-start lead. Stable sample and revision
digests allow later readers to deduplicate dashboard replay. Only allowlisted IDs,
times, token counts, status and epoch digests are saved in the private dashboard
metrics stream; prompts, responses, journal text, paths and credentials are absent.

## Attribution-yield audit

The dashboard now reports an honest corroboration rate over **resolved** engine
starts, with pending candidates outside that denominator. It also exposes bounded
abstention causes. A local read-only audit can deduplicate final revisions across
up to seven recent daily metric files and break the result down by configured
server:

```sh
npm run attribution:audit
# or: node ds4-gateway/attribution-audit.mjs --directory /absolute/private/dashboard --files 7
```

The audit reads at most 8 MiB per file and 65,536 attribution records. It rejects
symlink roots, skips symlinked/non-regular metric files, bounds individual lines,
and reports malformed/partial/truncated input instead of implying complete
history. Output contains counts, fixed reason codes and configured server IDs—no
prompts, responses, request/sample IDs, paths or credentials. Treat the report as
private deployment metadata and do not commit it.

This measures evidence yield on ordinary traffic; it does not validate a cache
hit or upgrade a candidate into protocol identity. Exact attribution would still
require a stock DS4 protocol signal, such as safely propagating an opaque request
ID into a structured timing event. That is an upstream opportunity to investigate,
not a private server-patch requirement. Until then, cache acquisition remains
component evidence and every ambiguous join stays unknown.
